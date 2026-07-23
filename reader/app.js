const queryInput = document.querySelector("#query");
const gameFilter = document.querySelector("#game-filter");
const resultsElement = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");
const noteElement = document.querySelector("#note");
const clearButton = document.querySelector("#clear-search");
const emptyState = document.querySelector("#empty-state");

let index;
let selectedId = new URLSearchParams(location.search).get("note");

function tokens(value) {
  return [...new Set((value.toLowerCase().match(/[a-z0-9]+/g) || []))];
}

function search() {
  const query = queryInput.value.trim();
  const selectedGame = gameFilter.value;
  const queryTokens = tokens(query);
  const scores = new Map();

  if (queryTokens.length === 0) {
    index.documents.forEach((document, documentId) => scores.set(documentId, 0));
  } else {
    for (const token of queryTokens) {
      for (const [documentId, count] of index.terms[token] || []) {
        scores.set(documentId, (scores.get(documentId) || 0) + count);
      }
    }
  }

  return [...scores]
    .map(([documentId, score]) => ({ ...index.documents[documentId], score }))
    .filter((document) => !selectedGame || document.game === selectedGame)
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function excerpt(document, query) {
  const body = document.body.replace(/\s+/g, " ").trim();
  const match = tokens(query).map((token) => body.toLowerCase().indexOf(token)).find((at) => at >= 0);
  const start = Math.max(0, (match ?? 0) - 92);
  const end = Math.min(body.length, start + 220);
  return `${start > 0 ? "..." : ""}${body.slice(start, end)}${end < body.length ? "..." : ""}`;
}

function updateUrl() {
  const parameters = new URLSearchParams();
  if (queryInput.value.trim()) parameters.set("q", queryInput.value.trim());
  if (gameFilter.value) parameters.set("game", gameFilter.value);
  if (selectedId) parameters.set("note", selectedId);
  history.replaceState(null, "", `${location.pathname}${parameters.size ? `?${parameters}` : ""}`);
}

function renderResults() {
  const results = search();
  resultsElement.replaceChildren();
  resultCount.textContent = `${results.length} note${results.length === 1 ? "" : "s"}`;
  clearButton.hidden = !(queryInput.value || gameFilter.value);

  for (const note of results) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "result-card";
    button.type = "button";
    button.dataset.selected = String(note.id === selectedId);
    button.addEventListener("click", () => {
      selectedId = note.id;
      updateUrl();
      renderResults();
      renderNote(note);
    });

    const meta = document.createElement("p");
    meta.className = "result-meta";
    meta.textContent = `${note.date} / ${note.game === "cs2" ? "CS2" : "CS:GO"}`;
    const title = document.createElement("h2");
    title.textContent = note.title;
    const preview = document.createElement("p");
    preview.className = "result-preview";
    preview.textContent = excerpt(note, queryInput.value);
    button.append(meta, title, preview);
    item.append(button);
    resultsElement.append(item);
  }

  if (results.length === 0) {
    const item = document.createElement("li");
    item.className = "no-results";
    item.textContent = "No notes match those filters.";
    resultsElement.append(item);
  }
  return results;
}

function inlineText(value) {
  const fragment = document.createDocumentFragment();
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\((https?:\/\/[^)]+)\)|<(https?:\/\/[^>]+)>)/g;
  let position = 0;
  for (const match of value.matchAll(pattern)) {
    fragment.append(document.createTextNode(value.slice(position, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      fragment.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      fragment.append(emphasis);
    } else {
      const link = document.createElement("a");
      link.href = match[3] || match[4];
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = match[2] || match[4];
      fragment.append(link);
    }
    position = match.index + token.length;
  }
  fragment.append(document.createTextNode(value.slice(position)));
  return fragment;
}

function renderNote(note) {
  if (!note) {
    noteElement.replaceChildren(emptyState.content.cloneNode(true));
    return;
  }
  const header = document.createElement("header");
  header.className = "note-header";
  const meta = document.createElement("p");
  meta.className = "eyebrow";
  meta.textContent = `${note.date} / ${note.game === "cs2" ? "Counter-Strike 2" : "Counter-Strike: Global Offensive"}`;
  const title = document.createElement("h1");
  title.textContent = note.title;
  const source = document.createElement("a");
  source.className = "source-link";
  source.href = note.source_url;
  source.target = "_blank";
  source.rel = "noreferrer";
  source.textContent = "View original Steam post";
  header.append(meta, title, source);

  const body = document.createElement("div");
  body.className = "note-body";
  for (const line of note.body.split("\n")) {
    if (!line || line === `# ${note.title}`) continue;
    const heading = line.match(/^(#{2,3})\s+(.+)$/);
    const bullet = line.match(/^(\s*)-\s+(.+)$/);
    const element = document.createElement(heading ? `h${heading[1].length}` : bullet ? "p" : "p");
    if (bullet) {
      element.className = "bullet";
      element.style.setProperty("--depth", String(Math.floor(bullet[1].length / 2)));
      element.append(inlineText(bullet[2]));
    } else {
      element.append(inlineText(heading ? heading[2] : line));
    }
    body.append(element);
  }
  noteElement.replaceChildren(header, body);
}

function refresh() {
  const results = renderResults();
  const selected = results.find((document) => document.id === selectedId);
  if (!selected && selectedId) selectedId = null;
  renderNote(selected || results[0]);
}

queryInput.addEventListener("input", () => { selectedId = null; updateUrl(); refresh(); });
gameFilter.addEventListener("change", () => { selectedId = null; updateUrl(); refresh(); });
clearButton.addEventListener("click", () => { queryInput.value = ""; gameFilter.value = ""; selectedId = null; updateUrl(); refresh(); });

async function load() {
  const parameters = new URLSearchParams(location.search);
  queryInput.value = parameters.get("q") || "";
  gameFilter.value = parameters.get("game") || "";
  index = await fetch("notes-index.json").then((response) => {
    if (!response.ok) throw new Error("Could not load the archive index");
    return response.json();
  });
  refresh();
}

load().catch((error) => {
  resultCount.textContent = "Archive unavailable";
  noteElement.textContent = error.message;
});
