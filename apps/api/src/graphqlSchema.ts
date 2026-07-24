import {
  Kind,
  buildSchema,
  getNamedType,
  isInterfaceType,
  isObjectType,
  parse,
  print,
  type DocumentNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";

type TypeReference = {
  kind: string;
  name?: string | null;
  ofType?: TypeReference | null;
};

type IntrospectionField = {
  name: string;
  args?: Array<{ name: string }> | null;
  type: TypeReference;
};

type IntrospectionType = {
  kind: string;
  name?: string | null;
  fields?: IntrospectionField[] | null;
};

export type SchemaIntrospection = {
  __schema: {
    queryType?: { name: string } | null;
    mutationType?: { name: string } | null;
    subscriptionType?: { name: string } | null;
    types: IntrospectionType[];
  };
};

export const INTROSPECTION_QUERY = `query SchemaCapabilities {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) {
        name
        args { name }
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType { kind name }
            }
          }
        }
      }
    }
  }
}`;

type FieldCapability = {
  arguments: Set<string>;
  typeName?: string;
};

type TypeCapability = {
  kind: string;
  fields: Map<string, FieldCapability>;
};

export type SchemaSnapshot = {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  types: Map<string, TypeCapability>;
};

function namedTypeName(reference: TypeReference | null | undefined) {
  let current = reference;
  while (current) {
    if (current.name) return current.name;
    current = current.ofType;
  }
  return undefined;
}

export function schemaFromIntrospection(
  data: SchemaIntrospection,
): SchemaSnapshot {
  const types = new Map<string, TypeCapability>();
  for (const type of data.__schema.types) {
    if (!type.name) continue;
    types.set(type.name, {
      kind: type.kind,
      fields: new Map(
        (type.fields ?? []).map((field) => [
          field.name,
          {
            arguments: new Set(
              (field.args ?? []).map((argument) => argument.name),
            ),
            typeName: namedTypeName(field.type),
          },
        ]),
      ),
    });
  }
  return {
    queryType: data.__schema.queryType?.name,
    mutationType: data.__schema.mutationType?.name,
    subscriptionType: data.__schema.subscriptionType?.name,
    types,
  };
}
export function schemaFromSdl(source: string): SchemaSnapshot {
  const schema = buildSchema(source);
  const types = new Map<string, TypeCapability>();
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    const fields =
      isObjectType(type) || isInterfaceType(type)
        ? new Map(
            Object.values(type.getFields()).map((field) => [
              field.name,
              {
                arguments: new Set(field.args.map((argument) => argument.name)),
                typeName: getNamedType(field.type).name,
              },
            ]),
          )
        : new Map<string, FieldCapability>();
    types.set(name, { kind: type.constructor.name, fields });
  }
  return {
    queryType: schema.getQueryType()?.name,
    mutationType: schema.getMutationType()?.name,
    subscriptionType: schema.getSubscriptionType()?.name,
    types,
  };
}
export function removeUnavailableCapabilities(
  schema: SchemaSnapshot,
  message: string,
) {
  let changed = false;
  for (const match of message.matchAll(
    /Cannot query field "([^"]+)" on type "([^"]+)"/g,
  )) {
    const [, fieldName, typeName] = match;
    if (fieldName && typeName) {
      changed = schema.types.get(typeName)?.fields.delete(fieldName) || changed;
    }
  }
  for (const match of message.matchAll(
    /Unknown argument "([^"]+)" on field "([^".]+)\\.([^"]+)"/g,
  )) {
    const [, argumentName, typeName, fieldName] = match;
    const field =
      typeName && fieldName
        ? schema.types.get(typeName)?.fields.get(fieldName)
        : undefined;
    if (argumentName && field) {
      changed = field.arguments.delete(argumentName) || changed;
    }
  }
  return changed;
}

function filterSelectionSet(
  schema: SchemaSnapshot,
  parentTypeName: string,
  selectionSet: SelectionSetNode,
): SelectionSetNode | null {
  const parentType = schema.types.get(parentTypeName);
  if (!parentType) return null;
  const selections = selectionSet.selections.flatMap<SelectionNode>(
    (selection) => {
      if (selection.kind === Kind.FRAGMENT_SPREAD) return [];
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const fragmentTypeName =
          selection.typeCondition?.name.value ?? parentTypeName;
        const filtered = filterSelectionSet(
          schema,
          fragmentTypeName,
          selection.selectionSet,
        );
        return filtered ? [{ ...selection, selectionSet: filtered }] : [];
      }

      if (selection.name.value === "__typename") return [selection];
      const field = parentType.fields.get(selection.name.value);
      if (!field) return [];
      const args = selection.arguments?.filter((argument) =>
        field.arguments.has(argument.name.value),
      );

      if (!selection.selectionSet) {
        const fieldType = field.typeName
          ? schema.types.get(field.typeName)
          : undefined;
        return fieldType?.fields.size
          ? []
          : [{ ...selection, arguments: args }];
      }
      if (!field.typeName) return [];
      const filtered = filterSelectionSet(
        schema,
        field.typeName,
        selection.selectionSet,
      );
      return filtered
        ? [{ ...selection, arguments: args, selectionSet: filtered }]
        : [];
    },
  );
  return selections.length ? { ...selectionSet, selections } : null;
}

function rootTypeFor(
  schema: SchemaSnapshot,
  operation: OperationDefinitionNode,
) {
  if (operation.operation === "query") return schema.queryType;
  if (operation.operation === "mutation") return schema.mutationType;
  return schema.subscriptionType;
}

export function adaptQueryToSchema(
  query: string,
  schema: SchemaSnapshot,
): string | null {
  const document = parse(query);
  const definitions = document.definitions.flatMap((definition) => {
    if (definition.kind !== Kind.OPERATION_DEFINITION) return [];
    const rootType = rootTypeFor(schema, definition);
    if (!rootType) return [];
    const selectionSet = filterSelectionSet(
      schema,
      rootType,
      definition.selectionSet,
    );
    return selectionSet ? [{ ...definition, selectionSet }] : [];
  });
  if (!definitions.length) return null;
  const adapted: DocumentNode = { ...document, definitions };
  return print(adapted);
}
