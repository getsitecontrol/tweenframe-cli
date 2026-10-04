import { meta, operations } from "./generated/contract.js";

export const apiUrl = (process.env.TWEENFRAME_API_URL ?? "https://tweenframe.com/api/public/v1").replace(/\/+$/, "");

// Guides live on the site that serves the API, so their origin follows TWEENFRAME_API_URL.
const origin = (() => {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return apiUrl;
  }
})();

export const docsUrl = (reference: string): string => new URL(reference, origin + "/").href;

// Fallbacks keep links working against a contract that predates the documentation fields.
export const docs = {
  skill: docsUrl(meta.docs.skill ?? "/docs/agent/SKILL.md"),
  errors: docsUrl("/docs/agent/errors.md"),
  index: docsUrl(meta.docs.index ?? "/docs/agent/index.json"),
};

export const errorDocs = (code: string): string => `${docs.errors}#${code}`;

// A group's guide is its tag's externalDocs, else the guide its first command links.
export function groupDocs(group: string): string {
  const reference = meta.groups.find((item) => item.name === group)?.docs
    ?? operations.find((op) => op.command.startsWith(`${group} `) && op.docs)?.docs;
  return reference ? docsUrl(reference) : docs.skill;
}
