import Markdown, { type Components } from "react-markdown";

const sourceActionLabel = "VIEW ORIGINAL STEAM POST ↗";
const outboundLinkAttributes = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

type NoteMarkdownProps = {
  body: string;
  title: string;
};

type SourceActionProps = {
  href: string;
};

type PreviewMarkdownProps = {
  markdown: string;
  queryTokens: string[];
};

type HastNode = {
  type: string;
  value?: string;
  children?: HastNode[];
};

export function bodyForRender(body: string, title: string): string {
  const duplicateTitle = `# ${title}`;

  if (body === duplicateTitle) return "";
  if (body.startsWith(`${duplicateTitle}\r\n`)) return body.slice(duplicateTitle.length + 2);
  if (body.startsWith(`${duplicateTitle}\n`)) return body.slice(duplicateTitle.length + 1);

  return body;
}

export function safeWebHref(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const markdownComponents = {
  a({ children, href, node: _node, ...anchorProps }) {
    const safeHref = safeWebHref(href);

    if (!safeHref) return <>{children}</>;

    return (
      <>
        <a {...anchorProps} className="note-link" href={safeHref} {...outboundLinkAttributes}>{children}</a>{" "}
        <sub className="link-domain">[{new URL(safeHref).hostname}]</sub>
      </>
    );
  },
} satisfies Components;

const previewComponents = {
  ...markdownComponents,
  p({ children, node: _node }) {
    return <>{children}</>;
  },
} satisfies Components;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalMarkPlugin(queryTokens: string[]) {
  const matcher = queryTokens.length > 0
    ? new RegExp(`(?<![a-z0-9])(${[...queryTokens].sort((left, right) => right.length - left.length || left.localeCompare(right)).map(escapeRegularExpression).join("|")})(?![a-z0-9])`, "gi")
    : undefined;

  return (tree: HastNode) => {
    if (!matcher) return;

    const markTextNode = (node: HastNode): HastNode[] => {
      if (node.type === "text" && node.value) {
        const parts = node.value.split(matcher);

        if (parts.length > 1) {
          return parts.map((part, index) => index % 2 === 1
            ? { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part }] }
            : { type: "text", value: part });
        }
      }

      if (node.children) node.children = node.children.flatMap(markTextNode);
      return [node];
    };

    if (tree.children) tree.children = tree.children.flatMap(markTextNode);
  };
}

export function normalizePreviewQueryTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

export function NoteMarkdown({ body, title }: NoteMarkdownProps) {
  return (
    <Markdown components={markdownComponents} urlTransform={safeWebHref}>
      {bodyForRender(body, title)}
    </Markdown>
  );
}

export function PreviewMarkdown({ markdown, queryTokens }: PreviewMarkdownProps) {
  return (
    <Markdown
      allowedElements={["p", "em", "strong", "a", "mark"]}
      components={previewComponents}
      rehypePlugins={[[literalMarkPlugin, queryTokens]]}
      skipHtml
      unwrapDisallowed
      urlTransform={safeWebHref}
    >
      {markdown}
    </Markdown>
  );
}

export function SourceAction({ href }: SourceActionProps) {
  const safeHref = safeWebHref(href);

  if (!safeHref) return <span className="source-link">{sourceActionLabel}</span>;

  return (
    <a className="source-link" href={safeHref} {...outboundLinkAttributes}>
      {sourceActionLabel}
    </a>
  );
}

export function OriginalSourceAction({ sourceUrl }: { sourceUrl: string }) {
  return <SourceAction href={sourceUrl} />;
}
