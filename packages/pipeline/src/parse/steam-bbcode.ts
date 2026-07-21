import type {
  CanonicalBlockData,
  CanonicalMediaItemData,
  DetectionEvidence,
  ParseDiagnostic,
  PristineSource,
  RegisteredParser,
  SourceSpan,
} from "./contract.js";
import { decodeSteamEntities } from "./entities.js";
import {
  STEAM_MAX_DIAGNOSTICS,
  STEAM_MAX_SOURCE_BYTES,
  tokenizeSteamBbcode,
  type SteamTagToken,
  type SteamToken,
} from "./steam-tokenizer.js";

export const STEAM_BBCODE_PARSER_VERSION = "1.0.0";

const STRUCTURAL_TAGS = new Set(["p", "list", "*", "h1", "h2", "h3", "h4", "h5", "h6", "img", "carousel"]);
const BRACKET_HEADING = /^\[\s*([^\]=/]+?)\s*\]$/;
const PLAIN_BULLET = /^(\s*)([-\u2013\u2014\u2022]+)\s+(\S[\s\S]*)$/;

interface TextNode {
  type: "text";
  value: string;
  sourceSpan: SourceSpan;
}

interface PlaceholderNode {
  type: "placeholder";
  sourceSpan: SourceSpan;
}

interface TagNode {
  type: "tag";
  name: string;
  attributes: Record<string, string>;
  sourceSpan: SourceSpan;
  children: TreeNode[];
}

interface UnsupportedNode {
  type: "unsupported";
  name: string;
  sourceSpan: SourceSpan;
}

type TreeNode = TextNode | PlaceholderNode | TagNode | UnsupportedNode;

interface RootNode {
  type: "root";
  children: TreeNode[];
}

interface TreeResult {
  children: TreeNode[];
  diagnostics: ParseDiagnostic[];
  partial: boolean;
}

function boundedDiagnostic(
  diagnostics: ParseDiagnostic[],
  code: string,
  sourceSpan: SourceSpan | null,
  details: ParseDiagnostic["details"] = {},
): void {
  if (diagnostics.length >= STEAM_MAX_DIAGNOSTICS) return;
  diagnostics.push({ severity: "error", code, sourceSpan, details });
}

function structuralDetection(source: PristineSource): DetectionEvidence {
  const tokenized = tokenizeSteamBbcode(source.pristineBody);
  const structural = tokenized.tokens.find(
    (token): token is SteamTagToken => token.type === "tag" && STRUCTURAL_TAGS.has(token.name),
  );
  const matched = structural !== undefined;

  return {
    matched,
    codes: [matched ? "STEAM_BLOCK_STRUCTURE" : "NO_STEAM_BLOCK_STRUCTURE"],
    spans: structural === undefined ? [] : [structural.sourceSpan],
    details: {
      hasStructuralBlockTag: matched,
      tokenizerStatus: tokenized.status,
    },
  };
}

function appendNode(parent: TagNode | RootNode, node: TreeNode): void {
  const previous = parent.children.at(-1);
  if (previous?.type === "text" && node.type === "text" && previous.sourceSpan.end === node.sourceSpan.start) {
    previous.value += node.value;
    previous.sourceSpan.end = node.sourceSpan.end;
    return;
  }
  parent.children.push(node);
}

function treeFromTokens(raw: string, tokens: readonly SteamToken[], consumedEnd: number): TreeResult {
  const root: RootNode = { type: "root", children: [] };
  const stack: Array<TagNode | RootNode> = [root];
  const diagnostics: ParseDiagnostic[] = [];
  let partial = false;

  const closeThrough = (stackIndex: number, end: number, reportUnclosed: boolean): void => {
    while (stack.length - 1 >= stackIndex) {
      const node = stack.pop();
      if (node === undefined || node.type === "root") break;
      node.sourceSpan.end = end;
      if (reportUnclosed) {
        partial = true;
        boundedDiagnostic(diagnostics, "UNCLOSED_TAG", node.sourceSpan, { nodeType: node.name });
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const parent = stack.at(-1) ?? root;

    if (token.type === "text") {
      appendNode(parent, { type: "text", value: token.value, sourceSpan: { ...token.sourceSpan } });
      continue;
    }
    if (token.type === "placeholder") {
      appendNode(parent, { type: "placeholder", sourceSpan: { ...token.sourceSpan } });
      continue;
    }

    if (token.type === "unknown") {
      if (token.closing) {
        partial = true;
        appendNode(parent, { type: "unsupported", name: token.name, sourceSpan: { ...token.sourceSpan } });
        continue;
      }

      let matchingClose = -1;
      for (let candidate = index + 1; candidate < tokens.length; candidate += 1) {
        const possible = tokens[candidate];
        if (possible.type === "unknown" && possible.closing && possible.name === token.name) {
          matchingClose = candidate;
          break;
        }
      }
      const end = matchingClose >= 0 ? tokens[matchingClose].sourceSpan.end : raw.length;
      appendNode(parent, {
        type: "unsupported",
        name: token.name,
        sourceSpan: { start: token.sourceSpan.start, end },
      });
      partial = true;
      if (matchingClose >= 0) index = matchingClose;
      else index = tokens.length;
      continue;
    }

    if (token.closing) {
      let matchingOpen = -1;
      for (let candidate = stack.length - 1; candidate > 0; candidate -= 1) {
        const node = stack[candidate];
        if (node.type === "tag" && node.name === token.name) {
          matchingOpen = candidate;
          break;
        }
      }
      if (matchingOpen < 0) {
        partial = true;
        appendNode(parent, {
          type: "unsupported",
          name: token.name,
          sourceSpan: { ...token.sourceSpan },
        });
      } else {
        if (stack.length - 1 > matchingOpen) {
          closeThrough(matchingOpen + 1, token.sourceSpan.start, false);
        }
        closeThrough(matchingOpen, token.sourceSpan.end, false);
      }
      continue;
    }

    if (token.name === "*") {
      let openItem = -1;
      for (let candidate = stack.length - 1; candidate > 0; candidate -= 1) {
        const node = stack[candidate];
        if (node.type === "tag" && node.name === "*") {
          openItem = candidate;
          break;
        }
        if (node.type === "tag" && node.name === "list") break;
      }
      if (openItem >= 0) closeThrough(openItem, token.sourceSpan.start, false);
    }

    const currentParent = stack.at(-1) ?? root;
    const node: TagNode = {
      type: "tag",
      name: token.name,
      attributes: { ...token.attributes },
      sourceSpan: { start: token.sourceSpan.start, end: token.sourceSpan.end },
      children: [],
    };
    appendNode(currentParent, node);
    if (!token.selfClosing) stack.push(node);
  }

  if (stack.length > 1) closeThrough(1, raw.length, true);
  if (consumedEnd < raw.length) {
    partial = true;
    appendNode(root, {
      type: "unsupported",
      name: "bounded_remainder",
      sourceSpan: { start: consumedEnd, end: raw.length },
    });
  }

  return { children: root.children, diagnostics, partial };
}

function cleanSemanticText(value: string): string {
  return decodeSteamEntities(value)
    .replace(/\\([\[\]])/g, "$1")
    .replace(/https?:\/\/[^\s<]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bracketHeadingLabel(value: string): string | null {
  const normalized = cleanSemanticText(value).replace(/^\\\[/, "[").replace(/\\\]$/, "]");
  const match = normalized.match(BRACKET_HEADING);
  return match === null ? null : cleanSemanticText(match[1]);
}

function semanticText(nodes: readonly TreeNode[]): string {
  const parts: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.type === "text") {
      parts.push(node.value);
      return;
    }
    if (node.type !== "tag") return;
    if (["list", "img", "carousel"].includes(node.name) || /^h[1-6]$/.test(node.name)) return;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return cleanSemanticText(parts.join(""));
}

function locatorText(nodes: readonly TreeNode[]): string {
  let value = "";
  const visit = (node: TreeNode): void => {
    if (node.type === "text") value += node.value;
    else if (node.type === "placeholder") value += "{STEAM_CLAN_IMAGE}";
    else if (node.type === "tag") for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return decodeSteamEntities(value).trim();
}

interface HeadingEntry {
  level: number;
  index: number;
}

interface MappingState {
  blocks: CanonicalBlockData[];
  mediaItems: CanonicalMediaItemData[];
  diagnostics: ParseDiagnostic[];
  partial: boolean;
  headings: HeadingEntry[];
  plainBulletParents: number[];
  plainBulletLists: number[];
}

function addBlock(state: MappingState, block: CanonicalBlockData): number {
  state.blocks.push(block);
  return state.blocks.length - 1;
}

function activeParent(state: MappingState, fallback: number | null): number | null {
  return state.headings.at(-1)?.index ?? fallback;
}

function nearestHeadingParent(state: MappingState, fromIndex: number): number | null {
  let cursor: number | null = fromIndex;
  while (cursor !== null) {
    const block: CanonicalBlockData = state.blocks[cursor];
    if (block.kind === "heading") return cursor;
    cursor = block.parentIndex;
  }
  return null;
}

function addHeading(
  state: MappingState,
  label: string,
  level: number,
  sourceSpan: SourceSpan,
  sourceNodeType: string,
  fallback: number | null,
): number {
  while (state.headings.length > 0 && (state.headings.at(-1)?.level ?? 0) >= level) {
    state.headings.pop();
  }
  const parentIndex = state.headings.at(-1)?.index ?? fallback;
  const index = addBlock(state, {
    kind: "heading",
    parentIndex,
    text: label,
    label,
    sourceSpan,
    sourceNodeType,
    diagnosticCode: null,
  });
  state.headings.push({ level, index });
  state.plainBulletParents = [];
  return index;
}

function addTextBlock(
  state: MappingState,
  kind: "paragraph" | "list_item" | "patch_change",
  text: string,
  parentIndex: number | null,
  sourceSpan: SourceSpan,
  sourceNodeType: string,
): number {
  return addBlock(state, {
    kind,
    parentIndex,
    text: cleanSemanticText(text),
    label: null,
    sourceSpan,
    sourceNodeType,
    diagnosticCode: null,
  });
}

function addUnsupported(state: MappingState, node: UnsupportedNode, parentIndex: number | null): void {
  addBlock(state, {
    kind: "unsupported",
    parentIndex,
    text: null,
    label: null,
    sourceSpan: node.sourceSpan,
    sourceNodeType: node.name,
    diagnosticCode: "UNSUPPORTED_CONSTRUCT",
  });
  boundedDiagnostic(state.diagnostics, "UNSUPPORTED_CONSTRUCT", node.sourceSpan, {
    nodeType: node.name,
  });
  state.partial = true;
}

function addImage(
  state: MappingState,
  node: TagNode,
  parentIndex: number | null,
  existingGroupIndex?: number,
): void {
  const locator = node.attributes.src ?? node.attributes.value ?? locatorText(node.children);
  const groupIndex = existingGroupIndex ?? addBlock(state, {
    kind: "media_group",
    parentIndex,
    text: null,
    label: null,
    sourceSpan: node.sourceSpan,
    sourceNodeType: "img",
    diagnosticCode: null,
  });
  if (locator.length === 0) {
    boundedDiagnostic(state.diagnostics, "MALFORMED_IMAGE", node.sourceSpan);
    state.partial = true;
    return;
  }
  state.mediaItems.push({
    groupBlockIndex: groupIndex,
    mediaKind: "image",
    originalLocator: locator,
    archiveLocator: null,
    caption: node.attributes.caption ?? null,
    altText: node.attributes.alt ?? null,
    sourceSpan: node.sourceSpan,
  });
}

function mapList(state: MappingState, node: TagNode, parentIndex: number | null): void {
  const listIndex = addBlock(state, {
    kind: "list",
    parentIndex,
    text: null,
    label: null,
    sourceSpan: node.sourceSpan,
    sourceNodeType: "list",
    diagnosticCode: null,
  });

  mapListChildren(state, node, listIndex);
}

function mapListChildren(state: MappingState, node: TagNode, listIndex: number): void {
  let lastItemIndex: number | null = null;
  for (const child of node.children) {
    if (child.type === "tag" && child.name === "*") {
      const text = semanticText(child.children);
      const itemIndex = text.length === 0
        ? listIndex
        : addTextBlock(state, "patch_change", text, listIndex, child.sourceSpan, "list_item");
      lastItemIndex = itemIndex === listIndex ? null : itemIndex;
      for (const nested of child.children) {
        if (nested.type === "tag" && nested.name === "list") {
          if (itemIndex === listIndex) mapListChildren(state, nested, listIndex);
          else mapList(state, nested, itemIndex);
        } else if (nested.type === "unsupported") {
          addUnsupported(state, nested, nearestHeadingParent(state, listIndex));
        } else if (nested.type === "tag" && nested.name === "img") {
          addImage(state, nested, nearestHeadingParent(state, listIndex));
        }
      }
    } else if (child.type === "tag" && child.name === "list") {
      if (lastItemIndex === null) mapListChildren(state, child, listIndex);
      else mapList(state, child, lastItemIndex);
    } else if (child.type === "unsupported") {
      addUnsupported(state, child, nearestHeadingParent(state, listIndex));
    } else {
      const text = semanticText([child]);
      if (text.length > 0) {
        lastItemIndex = addTextBlock(state, "list_item", text, listIndex, child.sourceSpan, "list_text");
      }
    }
  }
}

function sourceLines(value: string, start: number): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < value.length) {
    const newline = value.indexOf("\n", cursor);
    const rawEnd = newline < 0 ? value.length : newline;
    let lineEnd = rawEnd;
    if (lineEnd > cursor && value[lineEnd - 1] === "\r") lineEnd -= 1;
    const rawLine = value.slice(cursor, lineEnd);
    const leading = rawLine.length - rawLine.trimStart().length;
    const trailing = rawLine.length - rawLine.trimEnd().length;
    const text = rawLine.slice(leading, rawLine.length - trailing);
    if (text.length > 0) lines.push({
      text,
      start: start + cursor + leading,
      end: start + lineEnd - trailing,
    });
    cursor = newline < 0 ? value.length : newline + 1;
  }
  return lines;
}

function mapText(state: MappingState, node: TextNode, fallback: number | null): void {
  for (const line of sourceLines(node.value, node.sourceSpan.start)) {
    const heading = bracketHeadingLabel(line.text);
    if (heading !== null) {
      addHeading(state, heading, 2, { start: line.start, end: line.end }, "bracket_heading", fallback);
      continue;
    }

    const bullet = line.text.match(PLAIN_BULLET);
    if (bullet !== null) {
      const text = cleanSemanticText(bullet[3]);
      if (text.length === 0) continue;
      const depth = Math.max(0, bullet[1].length + bullet[2].length - 1);
      const parentIndex = depth > 0
        ? (() => {
            const owner = state.plainBulletParents[depth - 1];
            if (owner === undefined) return activeParent(state, fallback);
            const existingList = state.plainBulletLists[depth];
            if (existingList !== undefined && state.blocks[existingList].parentIndex === owner) {
              return existingList;
            }
            const listIndex = addBlock(state, {
              kind: "list",
              parentIndex: owner,
              text: null,
              label: null,
              sourceSpan: { start: line.start, end: line.end },
              sourceNodeType: "plain_nested_list",
              diagnosticCode: null,
            });
            state.plainBulletLists[depth] = listIndex;
            return listIndex;
          })()
        : activeParent(state, fallback);
      const itemIndex = addTextBlock(
        state,
        "patch_change",
        text,
        parentIndex,
        { start: line.start, end: line.end },
        "plain_bullet",
      );
      state.plainBulletParents[depth] = itemIndex;
      state.plainBulletParents.length = depth + 1;
      state.plainBulletLists.length = depth + 1;
      continue;
    }

    const text = cleanSemanticText(line.text);
    if (text.length === 0) continue;
    addTextBlock(
      state,
      "paragraph",
      text,
      activeParent(state, fallback),
      { start: line.start, end: line.end },
      "plain_text",
    );
    state.plainBulletParents = [];
    state.plainBulletLists = [];
  }
}

function mapParagraph(state: MappingState, node: TagNode, fallback: number | null): void {
  const structural = node.children.filter(
    (child) => child.type === "unsupported" || (child.type === "tag" && ["img", "list", "carousel"].includes(child.name)),
  );
  if (structural.length === 0) {
    const text = semanticText(node.children);
    const heading = bracketHeadingLabel(text);
    if (heading !== null) {
      addHeading(state, heading, 2, node.sourceSpan, "bracket_heading", fallback);
    } else if (text.length > 0) {
      addTextBlock(state, "paragraph", text, activeParent(state, fallback), node.sourceSpan, "p");
    }
    return;
  }

  let inline: TreeNode[] = [];
  const flush = (): void => {
    const text = semanticText(inline);
    if (text.length > 0) addTextBlock(state, "paragraph", text, activeParent(state, fallback), node.sourceSpan, "p");
    inline = [];
  };
  for (const child of node.children) {
    if (child.type === "tag" && child.name === "img") {
      flush();
      addImage(state, child, activeParent(state, fallback));
    } else if (child.type === "tag" && child.name === "list") {
      flush();
      mapList(state, child, activeParent(state, fallback));
    } else if (child.type === "tag" && child.name === "carousel") {
      flush();
      mapCarousel(state, child, activeParent(state, fallback));
    } else if (child.type === "unsupported") {
      flush();
      addUnsupported(state, child, activeParent(state, fallback));
    } else {
      inline.push(child);
    }
  }
  flush();
}

function mapCarousel(state: MappingState, node: TagNode, parentIndex: number | null): void {
  const groupIndex = addBlock(state, {
    kind: "media_group",
    parentIndex,
    text: null,
    label: null,
    sourceSpan: node.sourceSpan,
    sourceNodeType: "carousel",
    diagnosticCode: null,
  });
  for (const child of node.children) {
    if (child.type === "tag" && child.name === "img") addImage(state, child, parentIndex, groupIndex);
    else if (child.type === "unsupported") addUnsupported(state, child, parentIndex);
    else if (semanticText([child]).length > 0) {
      boundedDiagnostic(state.diagnostics, "UNSUPPORTED_CAROUSEL_CHILD", child.sourceSpan);
      state.partial = true;
    }
  }
}

function mapNode(state: MappingState, node: TreeNode, fallback: number | null): void {
  if (node.type === "text") {
    mapText(state, node, fallback);
    return;
  }
  if (node.type === "placeholder") return;
  if (node.type === "unsupported") {
    addUnsupported(state, node, activeParent(state, fallback));
    return;
  }

  if (/^h[1-6]$/.test(node.name)) {
    const text = semanticText(node.children);
    if (text.length > 0) addHeading(state, text, Number(node.name[1]), node.sourceSpan, node.name, fallback);
    return;
  }
  if (node.name === "p") {
    mapParagraph(state, node, fallback);
    return;
  }
  if (node.name === "list") {
    mapList(state, node, activeParent(state, fallback));
    return;
  }
  if (node.name === "img") {
    addImage(state, node, activeParent(state, fallback));
    return;
  }
  if (node.name === "carousel") {
    mapCarousel(state, node, activeParent(state, fallback));
    return;
  }

  const hasStructuralChild = node.children.some(
    (child) => child.type === "unsupported" || (child.type === "tag" && ["img", "list", "carousel"].includes(child.name)),
  );
  if (hasStructuralChild) {
    for (const child of node.children) mapNode(state, child, fallback);
    return;
  }
  const text = semanticText(node.children);
  const heading = bracketHeadingLabel(text);
  if (heading !== null) {
    addHeading(state, heading, 2, node.sourceSpan, "bracket_heading", fallback);
  } else if (text.length > 0) {
    addTextBlock(state, "paragraph", text, activeParent(state, fallback), node.sourceSpan, node.name);
  }
}

function subgroupHeading(node: TreeNode): { label: string; sourceSpan: SourceSpan; sourceNodeType: string } | null {
  const isConciseLabel = (value: string): boolean =>
    value.length <= 80 && value.split(/\s+/).length <= 8 && !/[.!?]$/.test(value);
  if (node.type === "tag" && node.name === "p") {
    const label = semanticText(node.children).replace(/:$/, "").trim();
    if (label.length > 0 && isConciseLabel(label) && bracketHeadingLabel(label) === null) {
      return { label, sourceSpan: node.sourceSpan, sourceNodeType: "p_subheading" };
    }
  }
  if (node.type === "text") {
    const lines = sourceLines(node.value, node.sourceSpan.start);
    if (lines.length === 1) {
      const label = cleanSemanticText(lines[0].text).replace(/:$/, "").trim();
      if (label.length > 0 && isConciseLabel(label) && bracketHeadingLabel(label) === null) {
        return {
          label,
          sourceSpan: { start: lines[0].start, end: lines[0].end },
          sourceNodeType: "plain_subheading",
        };
      }
    }
  }
  return null;
}

function mapNodes(state: MappingState, nodes: readonly TreeNode[], fallback: number | null): void {
  nodes.forEach((node, index) => {
    const next = nodes[index + 1];
    const subgroup = next?.type === "tag" && next.name === "list"
      ? subgroupHeading(node)
      : null;
    if (subgroup !== null) {
      addHeading(
        state,
        subgroup.label,
        3,
        subgroup.sourceSpan,
        subgroup.sourceNodeType,
        fallback,
      );
      return;
    }
    mapNode(state, node, fallback);
  });
}

function parse(source: PristineSource) {
  const tokenized = tokenizeSteamBbcode(source.pristineBody);
  const tree = treeFromTokens(source.pristineBody, tokenized.tokens, tokenized.consumedEnd);
  const state: MappingState = {
    blocks: [],
    mediaItems: [],
    diagnostics: tokenized.diagnostics.slice(0, STEAM_MAX_DIAGNOSTICS),
    partial: tokenized.status !== "complete" || tree.partial,
    headings: [],
    plainBulletParents: [],
    plainBulletLists: [],
  };
  for (const diagnostic of tree.diagnostics) {
    if (state.diagnostics.length >= STEAM_MAX_DIAGNOSTICS) break;
    state.diagnostics.push(diagnostic);
  }

  if (tokenized.status === "quarantined") {
    addUnsupported(state, {
      type: "unsupported",
      name: "source_limit",
      sourceSpan: { start: 0, end: source.pristineBody.length },
    }, null);
  } else {
    mapNodes(state, tree.children, null);
  }

  return {
    status: state.partial ? "partial" as const : "complete" as const,
    blocks: state.blocks,
    mediaItems: state.mediaItems,
    diagnostics: state.diagnostics.slice(0, STEAM_MAX_DIAGNOSTICS),
  };
}

export const steamNewsBbcodeParser: RegisteredParser = {
  key: "steam-news-bbcode",
  version: STEAM_BBCODE_PARSER_VERSION,
  detect: structuralDetection,
  parse,
};

// Keep this import-reachable constant tied to the parser's byte policy for static audits.
void STEAM_MAX_SOURCE_BYTES;
