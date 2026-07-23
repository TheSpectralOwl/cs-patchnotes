import Markdown, { type Components } from "react-markdown";

const sourceActionLabel = "VIEW ORIGINAL STEAM POST ↗";

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
  a({ children, href }) {
    const safeHref = safeWebHref(href);

    if (!safeHref) return <>{children}</>;

    return (
      <a className="note-link" href={safeHref} target="_blank" rel="noopener noreferrer">
        {children} <span className="link-domain">[{new URL(safeHref).hostname}]</span>
      </a>
    );
  },
} satisfies Components;

export function NoteMarkdown({ body, title }: { body: string; title: string }) {
  return (
    <Markdown components={markdownComponents} urlTransform={safeWebHref}>
      {bodyForRender(body, title)}
    </Markdown>
  );
}

export function SourceAction({ href }: { href: string }) {
  const safeHref = safeWebHref(href);

  if (!safeHref) return <span className="source-link">{sourceActionLabel}</span>;

  return (
    <a className="source-link" href={safeHref} target="_blank" rel="noopener noreferrer">
      {sourceActionLabel}
    </a>
  );
}

export function OriginalSourceAction({ sourceUrl }: { sourceUrl: string }) {
  return <SourceAction href={sourceUrl} />;
}
