import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import translations from "./translations.json";

export type Language =
  "en" | "fr" | "es" | "de" | "it" | "pt" | "pt-BR" | "ja" | "zh" | "ru" | "ar";

type I18nValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (text: string) => string;
};

const CATALOG = translations as Record<Language, Record<string, string>>;
const SUPPORTED_LANGUAGES: Language[] = [
  "en",
  "fr",
  "es",
  "de",
  "it",
  "pt",
  "pt-BR",
  "ja",
  "zh",
  "ru",
  "ar",
];

const exactTranslation = (text: string, language: Language) =>
  language === "en" ? text : (CATALOG[language][text] ?? text);

function translatedTemplate(
  key: string,
  replacements: Record<string, string>,
  language: Language,
) {
  let result = language === "en" ? key : (CATALOG[language][key] ?? key);
  for (const [name, value] of Object.entries(replacements))
    result = result.replaceAll(`{{${name}}}`, value);
  return result;
}

function translateText(text: string, language: Language) {
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  const core = text.trim();
  if (!core) return text;
  const onlineMatch = core.match(/^(\d+) of (\d+) online$/);
  if (onlineMatch) {
    return `${leading}${translatedTemplate("{{running}} of {{total}} online", { running: onlineMatch[1], total: onlineMatch[2] }, language)}${trailing}`;
  }
  const archiveMatch = core.match(/^Archive (.+)$/);
  if (archiveMatch) {
    return `${leading}${translatedTemplate("Archive {{name}}", { name: archiveMatch[1] }, language)}${trailing}`;
  }
  const removeMatch = core.match(/^Remove (.+)$/);
  if (removeMatch) {
    return `${leading}${translatedTemplate("Remove {{name}}", { name: removeMatch[1] }, language)}${trailing}`;
  }
  const editMatch = core.match(/^Edit (.+)$/);
  if (editMatch) {
    return `${leading}${translatedTemplate("Edit {{name}}", { name: editMatch[1] }, language)}${trailing}`;
  }
  const pageMatch = core.match(/^Page (\d+)$/);
  if (pageMatch) {
    return `${leading}${translatedTemplate("Page {{page}}", { page: pageMatch[1] }, language)}${trailing}`;
  }
  if (core.startsWith("· "))
    return `${leading}· ${exactTranslation(core.slice(2), language)}${trailing}`;
  const connectedMatch = core.match(/^Connected to (.+)\.$/);
  if (connectedMatch) {
    return `${leading}${translatedTemplate("Connected to {{hostname}}.", { hostname: connectedMatch[1] }, language)}${trailing}`;
  }
  const storageDevicesMatch = core.match(
    /^(\d+) devices · (\d+) pool devices$/,
  );
  if (storageDevicesMatch) {
    return `${leading}${translatedTemplate(
      "{{devices}} devices · {{pools}} pool devices",
      { devices: storageDevicesMatch[1], pools: storageDevicesMatch[2] },
      language,
    )}${trailing}`;
  }
  const telemetryCountMatch = core.match(
    /^(\d+) (sensors available|network interfaces?|memory slots?|memory modules?|USB devices?)$/,
  );
  if (telemetryCountMatch) {
    return `${leading}${translatedTemplate(
      `{{count}} ${telemetryCountMatch[2]}`,
      { count: telemetryCountMatch[1] },
      language,
    )}${trailing}`;
  }
  const countMatch = core.match(/^(\d+) (items|notifications?|errors?)$/);
  if (countMatch) {
    return `${leading}${translatedTemplate(`{{count}} ${countMatch[2]}`, { count: countMatch[1] }, language)}${trailing}`;
  }
  const englishKey = core;
  const translated =
    language === "en"
      ? englishKey
      : (CATALOG[language][englishKey] ?? englishKey);
  return `${leading}${translated}${trailing}`;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(() => {
    const stored = localStorage.getItem("unraid-language") as Language | null;
    return stored && SUPPORTED_LANGUAGES.includes(stored) ? stored : "en";
  });
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);
  const setLanguage = (next: Language) => {
    localStorage.setItem("unraid-language", next);
    updateLanguage(next);
  };
  return (
    <I18nContext.Provider
      value={{
        language,
        setLanguage,
        t: (text) => exactTranslation(text, language),
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

function localizeNode(node: ReactNode, language: Language): ReactNode {
  if (typeof node === "string") return translateText(node, language);
  if (Array.isArray(node))
    return node.map((child) => localizeNode(child, language));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.props.translate === "no") return element;
  const props = { ...element.props };
  for (const key of [
    "title",
    "label",
    "detail",
    "text",
    "placeholder",
    "aria-label",
  ]) {
    if (typeof props[key] === "string")
      props[key] = translateText(props[key], language);
  }
  if ("action" in props)
    props.action = localizeNode(props.action as ReactNode, language);
  if ("children" in props)
    props.children = Children.map(props.children as ReactNode, (child) =>
      localizeNode(child, language),
    );
  return cloneElement(element, props);
}

export function Localized({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  return <>{localizeNode(children, language)}</>;
}
