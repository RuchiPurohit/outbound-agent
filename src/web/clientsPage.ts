import type { OutboundStore } from "../db/store.js";
import type { Client } from "../db/types.js";
import {
  buildDocument, buildStagePrompt, DEFAULT_STEP_DELAY_DAYS, DOCUMENT_IDS, DOCUMENTS, MAX_SEQUENCE_STEPS, missingInputs,
  SECTIONS, STAGE_DOCUMENTS, STAGE_IDS, STEP_KINDS,
  type DocumentId, type SequenceStep, type SetupField, type SetupSection, type StageId,
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

/** Editor for the steps after the first email: one row per step plus a blank row to add one. */
function sequenceEditor(client: Client): string {
  const row = (step: SequenceStep | undefined, index: number): string => {
    const kinds = Object.entries(STEP_KINDS).map(([value, label]) =>
      `<option value="${value}"${(step?.kind ?? "email") === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
    const legend = step ? `Step ${index + 2}` : "Add a step";
    return `<fieldset class="seq-step${step ? "" : " seq-new"}"><legend>${legend}${step ? ` · ${escapeHtml(step.name)}` : ""}</legend><div class="seq-grid"><label><span>Type</span><select name="kind">${kinds}</select></label><label><span>Wait (days after previous step)</span><input type="number" name="delayDays" min="0" max="90" value="${step?.delayDays ?? DEFAULT_STEP_DELAY_DAYS}" required></label><label class="seq-name"><span>Name</span><input name="name" value="${escapeHtml(step?.name ?? "")}" maxlength="120" placeholder="${step ? "" : "e.g. LinkedIn connect"}"></label></div><label><span>Length rule (email steps)</span><input name="length" value="${escapeHtml(step?.length ?? "")}" maxlength="300" placeholder="Prefer 50–90 words and never exceed 110"></label><label><span>Template (email) or what to do (task)</span><textarea name="instructions" rows="${step ? Math.min(14, Math.max(4, step.instructions.split("\n").length + 1)) : 3}" maxlength="10000">${escapeHtml(step?.instructions ?? "")}</textarea></label>${step ? `<label class="inline setup-check"><input type="checkbox" name="remove" value="${index}"> Remove this step</label>` : '<small class="field-help">Leave the name and template empty to add nothing.</small>'}</fieldset>`;
  };
  const steps = client.setup.sequence;
  const rows = steps.map((step, index) => row(step, index)).join("") + (steps.length < MAX_SEQUENCE_STEPS ? row(undefined, steps.length) : "");
  return `<div class="sequence-editor" id="sequence-editor"><h4>Sequence</h4><p class="muted field-help">Step 1 is the first email (Email generation). Up to ${MAX_SEQUENCE_STEPS} more steps follow, each after its wait. Email steps are drafted as replies in the same thread and need approval and a send confirmation; task steps (LinkedIn, call, other) are done by you and marked done or skipped on the Sent &amp; follow-ups tab. Steps are kept by position: you can rename steps, edit templates, change waits, and add steps at the end at any time, but a step some prospects already reached keeps its type.</p><form method="post" action="/clients/${client.id}/sequence">${rows}<div class="actions"><button>Save sequence</button></div></form></div>`;
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
  return `<details class="card setup-section${kind}" id="section-${section.id}"${open ? " open" : ""}><summary><span class="step-no">${step}</span><span class="setup-title"><strong>${escapeHtml(section.title)}</strong><small>${escapeHtml(section.summary)}</small></span>${statusBadge(missing)}</summary>${source}${section.id === "follow-up-generation" ? sequenceEditor(client) : ""}<form method="post" action="/clients/${client.id}/sections/${section.id}">${section.id === "follow-up-generation" ? '<h4>Every follow-up email</h4>' : ""}${nameField}${fields}<div class="actions"><button>Save ${escapeHtml(section.title.toLowerCase())}</button></div></form>${preview}</details>`;
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
  return `<p class="muted" style="margin-top:0"><span class="eyebrow">Client ${client.id} · updated ${escapeHtml(new Date(client.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}</span><br>Fill in what changes from client to client. Each stage below builds its prompt from these inputs plus the fixed workflow and safety rules the dashboard enforces.</p><div class="actions"><a class="button" href="/campaigns?client=${client.id}">Open campaigns (${campaigns.length})</a><a class="button secondary" href="/campaigns?new=1&amp;client=${client.id}#campaign-detail">New campaign</a></div><nav class="funnel" aria-label="Funnel stages">${funnel}</nav><div class="setup-sections">${sections}</div>`;
}

function newClientForm(clients: Client[]): string {
  const options = clients.map((client) => `<option value="${client.id}">Copy of ${escapeHtml(client.name)}</option>`).join("");
  return `<p class="muted" style="margin-top:0">Each client has its own inputs for every funnel stage. Start blank, or copy an existing client and change what differs.</p><form method="post" action="/clients" class="new-client-form"><label><span>Client name</span><input name="name" required maxlength="200" placeholder="Acme Analytics"></label><label><span>Start from</span><select name="startFrom"><option value="blank">Blank: fill in every stage</option>${options}</select></label><button>Create client</button></form>`;
}

/**
 * The first page: a collapsible list of clients. Only the expanded client's details are
 * rendered; expanding another client loads the page with that client open.
 */
export function renderClientsPage(store: OutboundStore, url: URL): string {
  const clients = store.listClients();
  const creating = url.searchParams.get("new") === "1" || clients.length === 0;
  const requested = Number(url.searchParams.get("client"));
  const selected = creating ? undefined : clients.find(({ id }) => id === requested);
  const campaigns = store.listCampaigns();
  const items = clients.map((client) => {
    const count = campaigns.filter(({ clientId }) => clientId === client.id).length;
    const missing = [...SECTIONS, ...DOCUMENTS].reduce((total, section) => total + missingInputs(section.id, client.setup).length, 0);
    const open = client.id === selected?.id;
    const status = missing ? `<span class="badge PENDING">${missing} missing</span>` : '<span class="badge COMPLETED">Ready</span>';
    return `<details class="client-item" id="client-${client.id}"${open ? " open" : ""} data-client="${client.id}"${open ? " data-loaded" : ""}><summary><span class="chevron" aria-hidden="true"></span><strong class="client-name">${escapeHtml(client.name)}</strong><span class="client-meta">${count} campaign(s)</span>${status}</summary><div class="client-body">${open ? clientDetail(store, client, url.searchParams.get("open")) : '<p class="muted">Loading…</p>'}</div></details>`;
  }).join("");
  const newItem = `<details class="client-item new-item" id="new-client"${creating ? " open" : ""}><summary><strong class="client-name">+ New client</strong></summary><div class="client-body">${newClientForm(clients)}</div></details>`;
  return `<section><span class="eyebrow">Step 0 · Client setup</span><h1>Clients</h1><p class="lede">Set up what changes for each client before running campaigns: who to target, how to qualify, and how emails should read.</p></section><section class="card client-list" id="clients"><div class="cardhead"><h2>Clients <span class="badge">${clients.length}</span></h2><span class="muted field-help" style="margin:0">Click a client to open its setup.</span></div>${newItem}${items}</section><script>document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var t=document.getElementById(b.dataset.copy).textContent;navigator.clipboard.writeText(t).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)})});document.addEventListener('toggle',function(e){var d=e.target;if(!d.matches||!d.matches('details.client-item[data-client]')||!d.open||d.hasAttribute('data-loaded'))return;location.href='/?client='+d.dataset.client+'#client-'+d.dataset.client},true);</script>`;
}
