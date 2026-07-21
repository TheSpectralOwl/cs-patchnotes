import { createHash } from "node:crypto";
import type {
  CanonicalBlockData,
  CanonicalMediaItemData,
} from "./contract.js";

/** Incremented whenever semantic fragment eligibility or grouping changes. */
export const GROUPING_POLICY_VERSION = "1.0.0";

export interface FragmentAncestorData {
  blockIndex: number;
  label: string;
}

export interface SearchFragmentData {
  blockIndex: number;
  mediaItemIndex: number | null;
  fragmentKind: "block_text" | "media_caption";
  text: string;
  textSha256: string;
  groupAnchorBlockIndex: number | null;
  ancestors: FragmentAncestorData[];
}

const SEARCHABLE_BLOCK_KINDS = new Set<CanonicalBlockData["kind"]>([
  "heading",
  "paragraph",
  "list_item",
  "patch_change",
]);

function textSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function ancestorIndexes(
  blocks: readonly CanonicalBlockData[],
  blockIndex: number,
): number[] {
  const indexes: number[] = [];
  const seen = new Set<number>();
  let parentIndex = blocks[blockIndex]?.parentIndex ?? null;

  while (parentIndex !== null) {
    if (
      !Number.isSafeInteger(parentIndex) ||
      parentIndex < 0 ||
      parentIndex >= blockIndex ||
      seen.has(parentIndex)
    ) {
      throw new Error("Canonical fragment input contains an invalid parent chain");
    }
    seen.add(parentIndex);
    indexes.unshift(parentIndex);
    parentIndex = blocks[parentIndex].parentIndex;
  }

  return indexes;
}

function contextFor(
  blocks: readonly CanonicalBlockData[],
  blockIndex: number,
): { ancestors: FragmentAncestorData[]; headingAnchor: number | null } {
  const indexes = ancestorIndexes(blocks, blockIndex);
  const headingAnchor = [...indexes]
    .reverse()
    .find((index) => blocks[index].kind === "heading") ?? null;

  return {
    ancestors: indexes.map((index) => ({
      blockIndex: index,
      label: blocks[index].label ?? blocks[index].text ?? "",
    })),
    headingAnchor,
  };
}

/**
 * Build semantic retrieval units from source-neutral canonical data only.
 * Parser syntax, locators, filenames, alt text, and unsupported payloads are
 * deliberately absent from this boundary.
 */
export function buildSearchFragments(
  blocks: readonly CanonicalBlockData[],
  mediaItems: readonly CanonicalMediaItemData[] = [],
): SearchFragmentData[] {
  const mediaByBlock = new Map<number, Array<{ item: CanonicalMediaItemData; index: number }>>();
  mediaItems.forEach((item, index) => {
    if (
      !Number.isSafeInteger(item.groupBlockIndex) ||
      item.groupBlockIndex < 0 ||
      blocks[item.groupBlockIndex]?.kind !== "media_group"
    ) {
      throw new Error("Canonical media item does not belong to a media_group block");
    }
    const items = mediaByBlock.get(item.groupBlockIndex) ?? [];
    items.push({ item, index });
    mediaByBlock.set(item.groupBlockIndex, items);
  });

  const fragments: SearchFragmentData[] = [];
  blocks.forEach((block, blockIndex) => {
    const context = contextFor(blocks, blockIndex);

    if (SEARCHABLE_BLOCK_KINDS.has(block.kind) && block.text?.trim()) {
      const anchor = block.kind === "heading" ? blockIndex : context.headingAnchor;
      fragments.push({
        blockIndex,
        mediaItemIndex: null,
        fragmentKind: "block_text",
        text: block.text,
        textSha256: textSha256(block.text),
        groupAnchorBlockIndex: anchor,
        ancestors: context.ancestors,
      });
    }

    for (const { item, index } of mediaByBlock.get(blockIndex) ?? []) {
      if (!item.caption?.trim()) continue;
      fragments.push({
        blockIndex,
        mediaItemIndex: index,
        fragmentKind: "media_caption",
        text: item.caption,
        textSha256: textSha256(item.caption),
        groupAnchorBlockIndex: context.headingAnchor,
        ancestors: context.ancestors,
      });
    }
  });

  return fragments;
}
