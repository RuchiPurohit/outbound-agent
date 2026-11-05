import type { OutboundStore } from "../db/store.js";
import type { Client } from "../db/types.js";
import {
  buildDocument, buildStagePrompt, DOCUMENT_IDS, DOCUMENTS, missingInputs, SECTIONS, STAGE_DOCUMENTS, STAGE_IDS,
  type DocumentId, type SetupField, type SetupSection, type StageId,
} from "../prompts/clientSetup.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const slugOf = (client: Client): string =>
  client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `client-${client.id}`;

/** File name for a downloaded stage prompt, e.g. `convokit-company-discovery.md`. */
export function promptFileName(client: Client, stageId: StageId): string {
  return `${slugOf(client)}-${stageId}.md`;
}

/** File name for a downloaded client document, e.g. `convokit-ICP.md`. */
export function documentFileName(client: Client, documentId: DocumentId): string {
  return `${slugOf(client)}-${DOCUMENTS.find(({ id }) => id === documentId)!.fileName}`;
}

const isStage = (id: string): id is StageId => (STAGE_IDS as readonly string[]).includes(id);
const isDocument = (id: string): id is DocumentId => (DOCUMENT_IDS as readonly string[]).includes(id);

function fieldInput(field: SetupField, value: unknown): string {
  const name = `name="${escapeHtml(field.key)}"`;
  const help = field.help ? `<small class="field-help">${escapeHtml(field.help)}</small>` : "";
  if (field.kind === "checkbox") {
    return `<label class="inline setup-check"><input type="checkbox" ${name} value="yes"${value === true ? " checked" : ""}> ${escapeHtml(field.label)}</label>${help}`;
  }
  let control: string;
  if (field.kind === "number") {
    control = `<input type="number" ${name} value="${escapeHtml(value)}" min="${field.min ?? 0}" max="${field.max ?? 10000}" required style="max-width:140px">`;
  } else if (field.kind === "text") {
    control = `<input ${name} value="${escapeHtml(value)}" maxlength="1000">`;
  } else {
    const text = field.kind === "list" ? (value as string[]).join("\n") : String(value ?? "");
    const rows = Math.min(14, Math.max(3, text.split("\n").length + 1));
    control = `<textarea ${name} rows="${rows}" maxlength="60000"${field.kind === "list" ? ' class="list-input"' : ""}>${escapeHtml(text)}</textarea>`;
  }
  const hint = field.kind === "list" ? `<small class="field-help">One per line.${field.help ? ` ${escapeHtml(field.help)}` : ""}</small>` : help;
  return `<label><span>${escapeHtml(field.label)}</span>${control}${hint}</label>`;
}

function statusBadge(missing: string[]): string {
  return missing.length
    ? `<span class="badge PENDING" title="${escapeHtml(missing.join(", "))}">${missing.length} input(s) missing</span>`
    : '<span class="badge COMPLETED">Complete</span>';
}

function sectionCard(client: Client, section: SetupSection, step: number | string, open: boolean): string {
  const values = client.setup[section.id];
  const missing = missingInputs(section.id, client.setup);
  const nameField = section.id === "profile"
    ? `<label><span>Client name</span><input name="clientName" value="${escapeHtml(client.name)}" maxlength="200" required></label>` : "";
  const fields = section.fields.map((field) => fieldInput(field, values[field.key])).join("");
  const id = section.id;
  const generated = isStage(id)
    ? { label: "Generated prompt", text: buildStagePrompt(id, client.setup), href: `/clients/${client.id}/prompts/${id}.md` }
    : isDocument(id)
      ? { label: `Generated ${section.fileName}`, text: buildDocument(id, client.setup), href: `/clients/${client.id}/docs/${id}.md` }
      : undefined;
  const previewId = `generated-${id}`;
  const preview = generated
    ? `<details class="prompt-preview"><summary>${escapeHtml(generated.label)}</summary><div class="actions" style="margin:10px 0"><button type="button" class="secondary" data-copy="${previewId}">Copy</button><a class="button secondary" href="${generated.href}">Download .md</a></div><pre id="${previewId}">${escapeHtml(generated.text)}</pre></details>`
    : "";
  const reads = isStage(id) && STAGE_DOCUMENTS[id].length
    ? ` Reads the client's ${STAGE_DOCUMENTS[id].map((doc) => DOCUMENTS.find(({ id: docId }) => docId === doc)!.fileName).join(" and ")}.` : "";
  const source = section.source
    ? `<p class="muted field-help">Based on <code>${escapeHtml(section.source)}</code>, which workflows still use until this ${isDocument(id) ? "document" : "prompt"} replaces it.${reads}</p>` : "";
  const kind = isDocument(id) ? " doc" : isStage(id) ? " stage" : "";
  return `<details class="card setup-section${kind}" id="section-${section.id}"${open ? " open" : ""}><summary><span class="step-no">${step}</span><span class="setup-title"><strong>${escapeHtml(section.title)}</strong><small>${escapeHtml(section.summary)}</small></span>${statusBadge(missing)}</summary>${source}<form method="post" action="/clients/${client.id}/sections/${section.id}">${nameField}${fields}<div class="actions"><button>Save ${escapeHtml(section.title.toLowerCase())}</button></div></form>${preview}</details>`;
}

function clientDetail(store: OutboundStore, client: Client, openSection: string | null): string {
  const campaigns = store.listCampaigns().filter(({ clientId }) => clientId === client.id);
  const chip = (section: SetupSection, mark: string, kind: "doc" | "stage") => {
    const missing = missingInputs(section.id, client.setup).length;
    return `<a class="funnel-step ${kind}${missing ? " todo" : ""}" href="#section-${section.id}"${missing ? ` title="${missing} input(s) missing"` : ""}><span>${mark}</span>${escapeHtml(section.fileName ?? section.title)}</a>`;
  };
  const stages = SECTIONS.filter(({ id }) => id !== "profile");
  const funnel = `<div class="funnel-row"><span class="funnel-label">Documents</span><div class="funnel-chips">${DOCUMENTS.map((section) => chip(section, "D", "doc")).join("")}</div></div><div class="funnel-row"><span class="funnel-label">Stages</span><div class="funnel-chips">${stages.map((section, index) => chip(section, String(index + 1), "stage")).join("")}</div></div>`;
  const sections = `${sectionCard(client, SECTIONS[0]!, "★", openSection === "profile")}<h3 class="group-title">Documents</h3><p class="muted field-help" style="margin:0">Built from the inputs below plus related profile and stage inputs, so nothing is entered twice.</p>${DOCUMENTS.map((section) => sectionCard(client, section, "D", section.id === openSection)).join("")}<h3 class="group-title">Funnel stages</h3>${stages.map((section, index) => sectionCard(client, section, index + 1, section.id === openSection)).join("")}`;
  return `<div class="cardhead"><div><span class="eyebrow">Client ${client.id} · updated ${escapeHtml(new Date(client.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}</span><h2 class="detail-title">${escapeHtml(client.name)}</h2></div></div><p class="muted" style="margin-top:0">Fill in what changes from client to client. Each stage below builds its prompt from these inputs plus the fixed workflow and safety rules the dashboard enforces.</p><div class="actions"><a class="button" href="/campaigns?client=${client.id}">Open campaigns (${campaigns.length})</a><a class="button secondary" href="/campaigns?new=1&amp;client=${client.id}#campaign-detail">New campaign</a></div><nav class="funnel" aria-label="Funnel stages">${funnel}</nav><div class="setup-sections">${sections}</div>`;
}

function newClientForm(clients: Client[]): string {
  const options = clients.map((client) => `<option value="${client.id}">Copy of ${escapeHtml(client.name)}</option>`).join("");
  return `<div class="cardhead"><div><span class="eyebrow">New client</span><h2>Add a client</h2></div></div><p class="muted">Each client has its own inputs for every funnel stage. Start blank, or copy an existing client and change what differs.</p><form method="post" action="/clients"><label><span>Client name</span><input name="name" required maxlength="200" placeholder="Acme Analytics"></label><label><span>Start from</span><select name="startFrom"><option value="blank">Blank: fill in every stage</option>${options}</select></label><button>Create client</button></form>`;
}

/** The first page: clients on the left, the selected client's stage inputs on the right. */
export function renderClientsPage(store: OutboundStore, url: URL): string {
  const clients = store.listClients();
  const creating = url.searchParams.get("new") === "1" || clients.length === 0;
  const requested = Number(url.searchParams.get("client"));
  const selected = creating ? undefined : clients.find(({ id }) => id === requested) ?? clients[0];
  const campaigns = store.listCampaigns();
  const items = clients.map((client) => {
    const count = campaigns.filter(({ clientId }) => clientId === client.id).length;
    const missing = [...SECTIONS, ...DOCUMENTS].reduce((total, section) => total + missingInputs(section.id, client.setup).length, 0);
    const current = client.id === selected?.id;
    return `<a class="camp-item${current ? " active" : ""}" href="/?client=${client.id}#client-detail"${current ? ' aria-current="true"' : ""}><span class="camp-row"><strong>${escapeHtml(client.name)}</strong>${missing ? `<span class="badge PENDING">${missing} missing</span>` : '<span class="badge COMPLETED">Ready</span>'}</span><span class="camp-meta">${count} campaign(s)</span></a>`;
  }).join("");
  return `<section><span class="eyebrow">Step 0 · Client setup</span><h1>Clients</h1><p class="lede">Set up what changes for each client before running campaigns: who to target, how to qualify, and how emails should read.</p></section><div class="master" id="clients"><aside class="card camp-list"><div class="cardhead"><h2>Clients <span class="badge">${clients.length}</span></h2><a class="button${creating ? "" : " secondary"}" href="/?new=1#client-detail">+ New</a></div>${items ? `<nav aria-label="Clients">${items}</nav>` : '<p class="muted">No clients yet.</p>'}</aside><section class="card camp-detail" id="client-detail">${selected ? clientDetail(store, selected, url.searchParams.get("open")) : newClientForm(clients)}</section></div><script>document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var t=document.getElementById(b.dataset.copy).textContent;navigator.clipboard.writeText(t).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)})});</script>`;
}
