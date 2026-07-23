import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  bodyForRender,
  NoteMarkdown,
  OriginalSourceAction,
  safeWebHref,
} from "./note-markdown";

function renderNote(body: string, title = "Counter-Strike Update") {
  return renderToStaticMarkup(<NoteMarkdown body={body} title={title} />);
}

describe("NoteMarkdown", () => {
  it("preserves semantic CommonMark blocks, nesting, inline meaning, and source order", () => {
    const markup = renderNote(`# Counter-Strike Update

## Gameplay

A paragraph with *emphasis* and **strong text**.

- Top-level change
  - Nested change

### Details

Follow-up paragraph.`);

    const gameplay = markup.indexOf("<h2>Gameplay</h2>");
    const paragraph = markup.indexOf("<p>A paragraph with <em>emphasis</em> and <strong>strong text</strong>.</p>");
    const list = markup.indexOf("<ul>");
    const details = markup.indexOf("<h3>Details</h3>");

    expect(gameplay).toBeGreaterThanOrEqual(0);
    expect(paragraph).toBeGreaterThan(gameplay);
    expect(list).toBeGreaterThan(paragraph);
    expect(details).toBeGreaterThan(list);
    expect(markup).toContain("<li>Top-level change");
    expect(markup.slice(list)).toContain("<ul>");
    expect(markup).toContain("<li>Nested change</li>");
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("removes an exact leading duplicate title followed by %s", (_lineEnding, lineEnding) => {
    expect(bodyForRender(`# Counter-Strike Update${lineEnding}Body`, "Counter-Strike Update")).toBe("Body");
  });

  it("removes an exact leading duplicate title at end of input", () => {
    expect(bodyForRender("# Counter-Strike Update", "Counter-Strike Update")).toBe("");
  });

  it("retains distinct leading H1 text and later matching titles", () => {
    const markup = renderNote(`# Different heading

# Counter-Strike Update`);

    expect(markup).toContain("<h1>Different heading</h1>");
    expect(markup).toContain("<h1>Counter-Strike Update</h1>");
  });

  it.each([
    ["HTTP", "http://example.test/patch", "example.test"],
    ["HTTPS", "https://updates.example.test/patch", "updates.example.test"],
  ])("renders accepted %s links as isolated outbound anchors", (_protocol, destination, hostname) => {
    const markup = renderNote(`[Read the update](${destination})`);

    expect(markup).toContain(`href="${destination}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(`Read the update <span class="link-domain">[${hostname}]</span>`);
  });

  it.each([
    ["script-like", "javascript:alert(1)"],
    ["data-like", "data:text/html,alert(1)"],
    ["mail", "mailto:updates@example.test"],
    ["relative", "/updates"],
    ["protocol-relative", "//example.test/updates"],
    ["malformed", "https://"],
  ])("keeps %s destinations as plain author labels", (_kind, destination) => {
    const markup = renderNote(`[Unsafe destination](${destination})`);

    expect(markup).toContain("Unsafe destination");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("href=");
  });

  it("renders raw HTML as escaped source text", () => {
    const markup = renderNote("<script>window.__xss = true</script>");

    expect(markup).toContain("&lt;script&gt;window.__xss = true&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
  });
});

describe("safeWebHref", () => {
  it("accepts absolute HTTP and HTTPS URLs", () => {
    expect(safeWebHref("http://example.test/patch")).toBe("http://example.test/patch");
    expect(safeWebHref("https://example.test/patch")).toBe("https://example.test/patch");
  });

  it.each([
    undefined,
    "javascript:alert(1)",
    "data:text/html,alert(1)",
    "mailto:updates@example.test",
    "/updates",
    "//example.test/updates",
    "https://",
  ])("rejects non-web or malformed values: %s", (value) => {
    expect(safeWebHref(value)).toBeUndefined();
  });
});

describe("OriginalSourceAction", () => {
  it("retains the provenance label without a hostname suffix for a safe source URL", () => {
    const markup = renderToStaticMarkup(
      <OriginalSourceAction sourceUrl="https://store.steampowered.com/news/app/730" />,
    );

    expect(markup).toContain('href="https://store.steampowered.com/news/app/730"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(">VIEW ORIGINAL STEAM POST ↗</a>");
    expect(markup).not.toContain("link-domain");
  });

  it("leaves an invalid source URL as a non-clickable provenance label", () => {
    const markup = renderToStaticMarkup(<OriginalSourceAction sourceUrl="javascript:alert(1)" />);

    expect(markup).toContain("VIEW ORIGINAL STEAM POST ↗");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("link-domain");
  });
});
