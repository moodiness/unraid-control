import assert from "node:assert/strict";
import test from "node:test";
import { buildSchema, graphqlSync, parse, validate } from "graphql";
import {
  INTROSPECTION_QUERY,
  adaptQueryToSchema,
  removeUnavailableCapabilities,
  schemaFromIntrospection,
  schemaFromSdl,
  type SchemaIntrospection,
} from "./graphqlSchema.js";

const DASHBOARD_QUERY = `query Dashboard {
  info {
    cpu { brand manufacturer cores }
    versions { core { unraid api } }
    networkInterfaces { name ipAddress }
  }
  metrics { cpu { percentTotal } }
}`;

function introspectedSchema(source: string) {
  const serverSchema = buildSchema(source);
  const result = graphqlSync({
    schema: serverSchema,
    source: INTROSPECTION_QUERY,
  });
  assert.equal(result.errors, undefined);
  assert.ok(result.data);
  return {
    serverSchema,
    schema: schemaFromIntrospection(
      result.data as unknown as SchemaIntrospection,
    ),
  };
}

test("keeps every supported field from a modern NAS schema", () => {
  const { schema, serverSchema } = introspectedSchema(`
    type Query { info: Info!, metrics: Metrics! }
    type Info { cpu: Cpu!, versions: Versions!, networkInterfaces: [NetworkInterface!]! }
    type Cpu { brand: String, manufacturer: String, cores: Int }
    type Versions { core: CoreVersions! }
    type CoreVersions { unraid: String, api: String }
    type NetworkInterface { name: String!, ipAddress: String }
    type Metrics { cpu: CpuMetrics! }
    type CpuMetrics { percentTotal: Float! }
  `);
  const adapted = adaptQueryToSchema(DASHBOARD_QUERY, schema);
  assert.ok(adapted);
  assert.match(adapted, /manufacturer/);
  assert.match(adapted, /networkInterfaces/);
  assert.match(adapted, /percentTotal/);
  assert.deepEqual(validate(serverSchema, parse(adapted)), []);
});

test("removes unavailable fields while preserving an older NAS query", () => {
  const { schema, serverSchema } = introspectedSchema(`
    type Query { info: Info! }
    type Info { cpu: Cpu!, versions: Versions! }
    type Cpu { brand: String }
    type Versions { core: CoreVersions! }
    type CoreVersions { unraid: String }
  `);
  const adapted = adaptQueryToSchema(DASHBOARD_QUERY, schema);
  assert.ok(adapted);
  assert.match(adapted, /brand/);
  assert.match(adapted, /unraid/);
  assert.doesNotMatch(
    adapted,
    /manufacturer|cores|api|networkInterfaces|metrics/,
  );
  assert.deepEqual(validate(serverSchema, parse(adapted)), []);
});

test("skips a dashboard section when its root capability is absent", () => {
  const { schema } = introspectedSchema(`
    type Query { online: Boolean! }
  `);
  assert.equal(adaptQueryToSchema(DASHBOARD_QUERY, schema), null);
});

test("adapts queries from the official SDL fallback", () => {
  const schema = schemaFromSdl(`
    type Query { info: Info! }
    type Info { cpu: Cpu! }
    type Cpu { brand: String }
  `);
  const adapted = adaptQueryToSchema(DASHBOARD_QUERY, schema);
  assert.ok(adapted);
  assert.match(adapted, /brand/);
  assert.doesNotMatch(adapted, /manufacturer|networkInterfaces|metrics/);
});

test("learns permission-scoped fields rejected by the live NAS", () => {
  const schema = schemaFromSdl(`
    type Query { info: String, network: String }
  `);
  assert.equal(
    removeUnavailableCapabilities(
      schema,
      'Cannot query field "network" on type "Query".',
    ),
    true,
  );
  const adapted = adaptQueryToSchema(`query Live { info network }`, schema);
  assert.ok(adapted);
  assert.match(adapted, /info/);
  assert.doesNotMatch(adapted, /network/);
});
