/**
 * email_tool.js - Morena Mia Beauty Group / customer-communication skill
 *
 * Formatea correos, genera Compensation Labels, Return Labels y solicitudes Shalem,
 * y revisa un correo contra las reglas de la skill.
 *
 * NO pide datos por consola: el intake lo hace Claude en la conversacion (ver SKILL.md §2).
 * Cada funcion recibe un objeto y lanza Error si falta un dato; en ese caso se PREGUNTA
 * al usuario, nunca se rellena con un placeholder.
 *
 * Todos los datos de los demos son ficticios.
 */

const WRAP_WIDTH = 72;
const SIGNATURE = "Customer Service - Morena Mia Beauty Group";

// Terminos que nunca deben aparecer en un canal al cliente (SKILL.md §0.3, internal-ops.md).
const BANNED_TERMS = [
  "under $500", "always authorized", "auto-approved", "escalated to our superiors",
  "our usa warehouse", "clickup", "zendesk", "macro", "task", "due date",
  "internal_waiting", "cs_reply", "lost lead", "p+r", "resolution field", "bonus point",
  "master shipping", "sharefile", "nova",
  // Staff (nombres de pila y nombre completo interno de la agente)
  "karla", "erika", "lorenzo", "aviv", "donna", "zavala",
];

// Palabras claramente cosmeticas. Se quitaron "collection" y "set": son demasiado genericas
// y aparecen en nombres de dispositivos validos (p. ej. "Empire Ultimate Collection Suitcase").
const COSMETIC_WORDS = [
  "cream", "serum", "mask", "toner", "cleanser", "moisturizer", "foam", "peel",
  "butter", "gel", "mousse",
];

// Si el nombre contiene una de estas palabras se trata como dispositivo aunque tambien
// tenga una palabra cosmetica (p. ej. "LED Mask", "Gel Roller").
const DEVICE_HINTS = [
  "suitcase", "case", "device", "machine", "wand", "roller", "tool", "brush", "laser",
  "led", "dryer", "iron", "massager", "charger", "cable", "stand",
];

// Coincidencia por palabra completa (con plural simple) para no marcar "multitask" ni "macronutrient".
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term) {
  const body = escapeRegex(term);
  const start = /^\w/.test(term) ? "\\b" : "";
  const end = /\w$/.test(term) ? "(?:s)?\\b" : "";
  return new RegExp(start + body + end, "i");
}

function containsWord(text, words) {
  return words.some((w) => new RegExp(`\\b${escapeRegex(w)}\\b`, "i").test(text));
}

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------

function requireFields(data, fields, what) {
  const missing = fields.filter((f) => !String(data[f] ?? "").trim());
  if (missing.length) {
    throw new Error(`Missing field(s) for ${what}: ${missing.join(", ")}`);
  }
}

function cleanPhone(phone) {
  if (Array.isArray(phone)) phone = phone[0];
  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/\D/g, "");
  if (!raw.startsWith("+") || digits.length < 8) {
    throw new Error("Phone must include the country code (e.g. +1...). Ask the user.");
  }
  return "+" + digits;
}

// PO boxes y centros de recepcion de correo no se aceptan (SKILL.md 6A, product-issues.md 3).
const PO_BOX_PATTERN =
  /\bp\.?\s*o\.?\s*box\b|\bpost\s+office\s+box\b|\bpmb\b|\bups\s+store\b|\bapartado\s+postal\b|\bapdo\.?\s*postal\b/i;

function splitAddress(data) {
  const full = [data.street, data.city_state_zip, data.address].filter(Boolean).join(" ");
  if (PO_BOX_PATTERN.test(full)) {
    throw new Error(
      "PO boxes and mail-delivery facilities are not allowed. Ask the user for a physical street address."
    );
  }
  if (data.street && data.city_state_zip) {
    return [data.street.trim(), data.city_state_zip.trim()];
  }
  const parts = String(data.address || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 4) {
    throw new Error(
      "Address needs street, city, state/ZIP and country. Ask the user for the missing part " +
        "(or pass 'street' and 'city_state_zip' separately)."
    );
  }
  return [parts.slice(0, -3).join(", "), parts.slice(-3).join(", ")];
}

// ----------------------------------------------------------------------------
// Enlaces de productos (URL incrustada en el nombre del producto)
// ----------------------------------------------------------------------------

const PRODUCT_LINKS = [
  { name: "Multi-Vitamin Recovery 24H Night & Day Moisturizer", url: "https://www.dor24k.com/products/multi-vitamin-recovery-24h-moisturizer" },
  { name: "Multi-Vitamin Recovery 24H Moisturizer", url: "https://www.dor24k.com/products/multi-vitamin-recovery-24h-moisturizer" },
  { name: "24K Gold Peel & Moisturize System", url: "https://www.dor24k.com/products/moisturizer-set" },
  { name: "24K Gold Facial Peel System", url: "https://www.dor24k.com/products/facial-peeling" },
  { name: "Vitamin B5 Hydrafresh Moisturizing Toner", url: "https://www.dor24k.com/products/toner" },
  { name: "Turmeric Mousse Facial Cleanser", url: "https://www.dor24k.com/products/turmeric-mousse-facial-cleanser" },
  { name: "Exfoliating Pearl Milk Cleanser", url: "https://www.dor24k.com/products/milk-cleanser" },
  { name: "D'OR24K Advanced Eye Serum", url: "https://www.dor24k.com/products/eye-serum" },
  { name: "D'OR24K Advanced Eye Cream", url: "https://www.dor24k.com/products/eye-cream" },
  { name: "Advanced Eye Serum", url: "https://www.dor24k.com/products/eye-serum" },
  { name: "Advanced Eye Cream", url: "https://www.dor24k.com/products/eye-cream" },
  { name: "Foaming Everyday Cleanser", url: "https://www.stemtox.com/product/foaming-everyday-cleanser/" },
  { name: "Chamomile Reset Toner", url: "https://www.stemtox.com/product/chamomile-reset-toner/" },
  { name: "Rice Milk Cleanser", url: "https://www.stemtox.com/product/rice-milk-cleanser/" },
  { name: "C.TOX + D.TOX Bundle", url: "https://www.stemtox.com/product/c-tox-d-tox-bundle/" },
  { name: "C.TOX + D.TOX", url: "https://www.stemtox.com/product/c-tox-d-tox-bundle/" },
  { name: "Submarine Max Pro Plus", url: "https://emptechpro.com/products/submarine-max-pro-plus" },
  { name: "D.TOX", url: "https://www.stemtox.com/product/d-tox/" },
  { name: "E.TOX", url: "https://www.stemtox.com/product/e-tox/" },
];

/**
 * Incrusta la URL oficial en la primera mencion de cada producto conocido dentro del texto,
 * sin tocar Subject:, enlaces Markdown existentes ni URLs desnudas.
 */
function embedProductLinks(text, links = PRODUCT_LINKS) {
  const sorted = [...links].sort((a, b) => b.name.length - a.name.length);
  const linkedUrls = new Set();

  // Procesa linea por linea para no tocar Subject:
  return String(text)
    .split("\n")
    .map((line) => {
      if (/^Subject:/i.test(line)) return line;

      // Divide en tokens preservando enlaces Markdown existentes [texto](url) y URLs
      const parts = line.split(/(\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)/gi);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) continue; // ya es un enlace o URL
        let chunk = parts[i];
        for (const item of sorted) {
          if (linkedUrls.has(item.url)) continue;
          const re = new RegExp(`(^|[^\\w.])(${escapeRegex(item.name)})(?=$|\\W)`, "i");
          if (re.test(chunk)) {
            chunk = chunk.replace(re, (_, prefix, matched) => `${prefix}[${matched}](${item.url})`);
            linkedUrls.add(item.url);
          }
        }
        parts[i] = chunk;
      }
      return parts.join("");
    })
    .join("\n");
}

function checkProductLinks(text) {
  const issues = [];
  if (/\[[^\]]+\]\s+\(https?:\/\/[^)\s]*(?:dor24k\.com|stemtox\.com|emptechpro\.com)/i.test(text)) {
    issues.push("Malformed product link: remove space or newline between ']' and '('.");
  }
  if (/`\[[^\]]+\]\(https?:\/\/[^)`]*(?:dor24k\.com|stemtox\.com|emptechpro\.com)[^)`]*\)`/i.test(text)) {
    issues.push("Product link is inside inline code backticks (`); remove backticks so it is clickable.");
  }
  const bare = text.replace(/\[[^\]]+\]\([^)]*\)/g, "");
  if (/(?:https?:\/\/|www\.)\S*(?:dor24k\.com|stemtox\.com|emptechpro\.com)\S*/i.test(bare)) {
    issues.push("Bare product URL found; embed it in the product name as [Product Name](URL).");
  }
  return issues;
}

// ----------------------------------------------------------------------------
// Correo
// ----------------------------------------------------------------------------

function wrapParagraph(text, width = WRAP_WIDTH) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  // Mantiene [texto](url) como un solo token para no partir enlaces entre dos lineas
  const tokens = [];
  const linkRe = /\[[^\]]+\]\([^)]+\)/g;
  let lastIdx = 0;
  let m;
  while ((m = linkRe.exec(clean)) !== null) {
    if (m.index > lastIdx) {
      tokens.push(...clean.slice(lastIdx, m.index).trim().split(" ").filter(Boolean));
    }
    tokens.push(m[0]);
    lastIdx = linkRe.lastIndex;
  }
  if (lastIdx < clean.length) {
    tokens.push(...clean.slice(lastIdx).trim().split(" ").filter(Boolean));
  }

  const lines = [];
  let current = "";
  for (const token of tokens) {
    if (!current) {
      current = token;
    } else if ((current + " " + token).length <= width) {
      current += " " + token;
    } else {
      lines.push(current);
      current = token;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function formatEmail(subject, greeting, paragraphs, closing = "Warm regards", signature = SIGNATURE) {
  if (!paragraphs || !paragraphs.length) {
    throw new Error("An email needs at least one paragraph.");
  }
  const lines = [`Subject: ${subject.toUpperCase()}`, "", greeting.replace(/,\s*$/, "") + ",", ""];
  paragraphs.forEach((para, i) => {
    lines.push(wrapParagraph(para));
    if (i < paragraphs.length - 1) lines.push("");
  });
  lines.push("", closing.replace(/,\s*$/, "") + ",", signature);
  return lines.join("\n") + "\n";
}

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseDateUtcNoon(raw) {
  if (!raw) {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0));
  }
  const iso = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date '${raw}'. Use YYYY-MM-DD.`);
  }
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0));
}

function getNextBusinessDay(baseDateStr = null) {
  const d = parseDateUtcNoon(baseDateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const dow = EN_WEEKDAYS[d.getUTCDay()];
  const month = EN_MONTHS[d.getUTCMonth()];
  return {
    iso: `${yyyy}-${mm}-${dd}`,
    weekday: dow,
    english: `${dow}, ${month} ${d.getUTCDate()}, ${yyyy}`,
    shortEnglish: `${month} ${d.getUTCDate()}, ${yyyy}`,
  };
}

function checkBusinessDayDates(text) {
  const issues = [];
  if (/\b(Saturday|Sunday)\b/i.test(text)) {
    issues.push(
      "Weekend day ('Saturday' or 'Sunday') mentioned in customer text; follow-ups must be Monday–Friday only."
    );
  }
  const monthPattern = new RegExp(
    `\\b(${EN_MONTHS.join("|")})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`,
    "gi"
  );
  let m;
  while ((m = monthPattern.exec(text)) !== null) {
    const monthIdx = EN_MONTHS.findIndex((mo) => mo.toLowerCase() === m[1].toLowerCase());
    const dayNum = Number(m[2]);
    const yearNum = Number(m[3]);
    if (monthIdx >= 0) {
      const d = new Date(Date.UTC(yearNum, monthIdx, dayNum, 12, 0, 0));
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) {
        const nextBiz = getNextBusinessDay(`${yearNum}-${String(monthIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`);
        issues.push(
          `Date '${m[0]}' falls on a ${EN_WEEKDAYS[dow]} (non-working day); use ${nextBiz.english} instead.`
        );
      }
    }
  }
  return issues;
}

function checkEmail(text) {
  const issues = [];
  if (!text.includes('LANG: EN')) {
    issues.push("Missing required LANG: EN header.");
  }
  const m = text.match(/^Subject:\s*(.+)/m);
  if (!m) {
    issues.push("Missing 'Subject:' line.");
  } else {
    const subject = m[1];
    if (subject !== subject.toUpperCase()) {
      issues.push("Subject must be in CAPITALS.");
    }
    if (!/^#\d+ - .+ - .+/.test(subject)) {
      issues.push("Subject format must be '#INVOICE - STORE NAME - SHORT REASON'.");
    }
  }
  if (!text.includes(SIGNATURE)) {
    issues.push("Missing exact signature.");
  }
  // [texto](url) es un hipervinculo valido, no un placeholder
  if (/\[[^\]]+\](?!\()/.test(text)) {
    issues.push("Square-bracket placeholder found.");
  }
  issues.push(...checkTrackingLinks(text));
  issues.push(...checkProductLinks(text));
  issues.push(...checkBusinessDayDates(text));
  if (/\b(Mr|Ms|Mrs)\./.test(text)) {
    issues.push("Honorific found.");
  }
  if (/888-249-4189|customerservice@emacaribbean\.com/.test(text)) {
    issues.push("Phone/email repeated in the body (the system adds them).");
  }
  for (const term of BANNED_TERMS) {
    if (termRegex(term).test(text)) {
      issues.push(`Internal term in customer text: '${term}'.`);
    }
  }
  let body = text.includes("\n\n") ? text.split("\n\n").slice(1).join("\n\n") : text;
  body = body.split(SIGNATURE)[0];
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < 120 || words > 220) {
    issues.push(`Body has ${words} words; target is 120-220.`);
  }
  return issues;
}

// ----------------------------------------------------------------------------
// Tracking FedEx
// ----------------------------------------------------------------------------

const FEDEX_TRACK_URL = "https://www.fedex.com/fedextrack/?trknbr={n}";

function formatTrackingLink(tracking_number = null, url = null, fmt = "markdown") {
  let number = String(tracking_number || "").replace(/[\s-]/g, "");
  let link = String(url || "").trim();

  if (link.startsWith("[")) {
    const m = link.match(/\[([^\]]*)\]\s*\((https?:\/\/[^)\s]+)\)/i);
    if (!m) {
      throw new Error("Could not read the URL inside the link. Ask the user for the full FedEx URL.");
    }
    if (!number && m[1]) {
      const candidate = m[1].replace(/[\s-]/g, "");
      if (/^\d{10,34}$/.test(candidate)) number = candidate;
    }
    link = m[2];
  }

  // Limpiar posibles caracteres de cierre o espacios accidentales al final de la URL
  link = link.replace(/[.,;>]+$/, "");

  if (link) {
    if (/^www\.fedex\.com/i.test(link)) {
      link = "https://" + link;
    }
    const m = link.match(/[?&](?:trknbr|trackingnumber|tracknumbers)=(\d+)/i);
    if (!m) {
      throw new Error("The URL has no 'trknbr=<number>'. Ask the user for the full FedEx tracking URL.");
    }
    const urlNumber = m[1];
    if (number && number !== urlNumber) {
      throw new Error(
        `Tracking number ${number} does not match the URL (${urlNumber}). Ask the user which is right.`
      );
    }
    number = urlNumber;
    const q = link.match(/[?&]trkqual=[^&]*?~(\d+)~/);
    if (q && q[1] !== number) {
      throw new Error("The number inside trkqual does not match trknbr. Ask the user to confirm the URL.");
    }
  } else {
    if (!number) {
      throw new Error("Missing tracking number or URL. Ask the user.");
    }
    link = FEDEX_TRACK_URL.replace("{n}", number);
  }

  if (!/^\d+$/.test(number) || number.length < 10 || number.length > 34) {
    throw new Error(`'${number}' does not look like a FedEx tracking number. Ask the user.`);
  }
  if (!link.toLowerCase().startsWith("https://")) {
    throw new Error("The tracking URL must start with https://. Ask the user.");
  }
  if (fmt === "html") {
    return `<a href="${link}" target="_blank" rel="noopener noreferrer">${number}</a>`;
  }
  return `[${number}](${link})`;
}

function checkTrackingLinks(text) {
  const issues = [];
  // Detectar enlaces con espacio o salto de linea entre ] y (
  if (/\[[^\]]+\]\s+\(https?:\/\/[^)\s]*fedex\.com/i.test(text)) {
    issues.push("Malformed FedEx link: remove space or newline between ']' and '('.");
  }
  // Detectar enlaces envueltos en backticks `...`
  if (/`\[[^\]]+\]\(https?:\/\/[^)`]*fedex\.com[^)`]*\)`/i.test(text)) {
    issues.push("FedEx link is inside inline code backticks (`); remove backticks so it is clickable.");
  }
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]*fedex\.com[^)\s]*)\)/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const anchor = m[1].trim();
    const link = m[2].trim();
    const tm = link.match(/[?&](?:trknbr|trackingnumber|tracknumbers)=(\d+)/i);
    if (!tm || anchor !== tm[1]) {
      issues.push("FedEx link: anchor text must be only the tracking number (same as trknbr in the URL).");
    }
  }
  const bare = text.replace(/\[[^\]]+\]\([^)]*\)/g, "");
  if (/(?:https?:\/\/|www\.)\S*fedex\.com\S*/i.test(bare)) {
    issues.push("Bare FedEx URL found; use [tracking number](full URL).");
  }
  return issues;
}

// ----------------------------------------------------------------------------
// Etiquetas
// ----------------------------------------------------------------------------

function generateCompensationLabel(data) {
  requireFields(data, ["invoice", "customer", "product", "email", "phone", "reason"], "compensation label");
  const [street, rest] = splitAddress(data);
  const invoice = String(data.invoice).replace(/^#/, "");
  const lines = [
    `#${invoice} - ${data.customer.toUpperCase()}`,
    data.product,
    street,
    rest,
    data.email,
    `Tel: ${cleanPhone(data.phone)}`,
    data.reason,
    "Overnight",
  ];
  if (data.previous_shipping) {
    lines.push("*Previous shipping");
  }
  return lines.join("\n");
}

function generateReturnLabel(data) {
  requireFields(
    data,
    ["invoice", "customer", "address", "phone", "email", "device", "reason"],
    "return label"
  );
  const device = data.device;
  if (containsWord(device, COSMETIC_WORDS) && !containsWord(device, DEVICE_HINTS)) {
    throw new Error(
      `'${device}' looks like a cosmetic. Return labels are for devices only; confirm with the user.`
    );
  }
  const invoice = String(data.invoice).replace(/^#/, "");
  const [street, rest] = splitAddress(data);
  const note = data.note || "Replacement ships once the returned device arrives at the warehouse.";
  const lines = [
    `${invoice} - ${data.customer}`,
    `${street}, ${rest}`,
    cleanPhone(data.phone),
    data.email,
    device,
    data.reason,
    "Return Label (RL)",
    note,
  ];
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Shalem
// ----------------------------------------------------------------------------

function generateShalemRequest(data) {
  requireFields(data, ["name", "address", "email", "phone"], "Shalem request");
  const lines = [
    `Nombre : ${data.name}`,
    `Direccion: ${data.address}`,
    `Correo electronico: ${data.email}`,
    `Numero de telefono: ${cleanPhone(data.phone)}`,
  ];
  if (data.invoice) lines.push(`Invoice: ${data.invoice}`);
  if (data.amount) lines.push(`Monto: ${data.amount}`);
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Tablas para Zendesk (Markdown GFM / Rich HTML / TSV estilo Excel)
// ----------------------------------------------------------------------------

function sanitizeTableCell(val) {
  return String(val ?? "")
    .replace(/\r?\n+/g, " / ")
    .replace(/\|/g, "\\|")
    .trim();
}

function escapeHtmlCell(val) {
  return String(val ?? "")
    .replace(/\r?\n+/g, " / ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .trim();
}

function formatZendeskTable(headers, rows, fmt = "markdown") {
  if (!Array.isArray(headers) || !headers.length) {
    throw new Error("formatZendeskTable requires a non-empty headers array.");
  }
  if (!Array.isArray(rows)) {
    throw new Error("formatZendeskTable requires a rows array.");
  }
  const mode = String(fmt || "markdown").toLowerCase();
  if (mode === "tsv") {
    const cleanTsv = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();
    const lines = [headers.map(cleanTsv).join("\t")];
    for (const r of rows) {
      lines.push(headers.map((_h, idx) => cleanTsv(r[idx] ?? "")).join("\t"));
    }
    return lines.join("\n");
  }
  if (mode === "html") {
    const ths = headers
      .map(
        (h) =>
          `<th style="border: 1px solid #d0d7de; padding: 6px 10px; background-color: #f6f8fa; font-weight: 600; text-align: left;">${escapeHtmlCell(h)}</th>`
      )
      .join("");
    const trs = rows
      .map((r) => {
        const tds = headers
          .map(
            (_h, idx) =>
              `<td style="border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top;">${escapeHtmlCell(r[idx] ?? "")}</td>`
          )
          .join("");
        return `<tr>${tds}</tr>`;
      })
      .join("");
    return `<table style="border-collapse: collapse; width: 100%; font-size: 14px;"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  }
  // Por defecto: Markdown GFM limpio fuera de bloques de codigo
  const headerLine = `| ${headers.map(sanitizeTableCell).join(" | ")} |`;
  const sepLine = `| ${headers.map(() => ":---").join(" | ")} |`;
  const bodyLines = rows.map(
    (r) => `| ${headers.map((_h, idx) => sanitizeTableCell(r[idx] ?? "")).join(" | ")} |`
  );
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

// ----------------------------------------------------------------------------
// Demos (datos ficticios)
// ----------------------------------------------------------------------------

function demoEmail() {
  return "LANG: EN\n" + formatEmail(
    "#224789 - SPRINGFIELD STORE - REPLACEMENT SHIPMENT CONFIRMATION",
    "Hi Jane",
    [
      "Thank you for taking the time to speak with us about your Hyaluronic Acid Eye Cream. " +
        "I am sorry the product did not meet your expectations, and I want to make sure you feel " +
        "fully supported while we put this right.",
      "We have prepared a replacement for you at no cost. It will ship overnight to the address " +
        "you confirmed with us, and we will send you the tracking number as soon as it is generated " +
        "so you can follow the delivery every step of the way.",
      "To keep everything on track, I will reach out to you again on October 9, 2026 to confirm " +
        "that the package arrived and that you are happy with it. If you notice anything before " +
        "then, simply reply to this message and we will take care of it right away.",
      "Thank you again for your patience and for being part of the Morena Mia family.",
    ]
  );
}

const DEMO_CUSTOMER = {
  invoice: "224789",
  customer: "Jane Doe",
  address: "123 Main Street, Apt 4, Springfield, IL 62704, USA",
  email: "jane.doe@example.com",
  phone: "+15555550123",
};

function demoCompensationLabel() {
  return generateCompensationLabel({
    ...DEMO_CUSTOMER,
    product: "1 Hyaluronic Acid Eye Cream",
    reason: "Regret",
  });
}

function demoReturnLabel() {
  return generateReturnLabel({
    ...DEMO_CUSTOMER,
    device: "Marvelous Signature",
    reason: "Defective",
  });
}

function demoShalemRequest() {
  return generateShalemRequest({
    name: "John Roe",
    address: "45 Oak Avenue, Atlanta, GA 30301, USA",
    email: "john.roe@example.com",
    phone: "+15555550188",
  });
}

// ----------------------------------------------------------------------------
// Main (equivalente a if __name__ == "__main__")
// ----------------------------------------------------------------------------

function main() {
  const email = demoEmail();
  console.log("--- EMAIL ---\n" + email);
  const issues = checkEmail(email);
  console.log("check_email ->", issues.length ? issues : "OK");
  console.log("\n--- NEXT BUSINESS DAY (Friday 2026-10-16 -> Monday) ---");
  console.log(getNextBusinessDay("2026-10-16"));
  console.log("\n--- COMPENSATION LABEL ---\n" + demoCompensationLabel());
  console.log("\n--- RETURN LABEL ---\n" + demoReturnLabel());
  console.log("\n--- SHALEM ---\n" + demoShalemRequest());
  console.log(
    "\n--- TRACKING LINK ---\n" +
      formatTrackingLink(
        "383984501024",
        "https://www.fedex.com/fedextrack/?trknbr=383984501024&trkqual=2461316000~383984501024~FX"
      )
  );
  console.log(
    "\n--- ZENDESK TABLE (MARKDOWN GFM) ---\n" +
      formatZendeskTable(
        ["Field", "Detail"],
        [
          ["Invoice #", "#224789"],
          ["Customer", "Jane Doe"],
          ["Device", "Marvelous Signature"],
          ["Tracking", "[383984501024](https://www.fedex.com/fedextrack/?trknbr=383984501024)"],
        ]
      )
  );
}

// Solo ejecuta los demos o el CLI al correr `node email_tool.js`; al importarlo con require() no imprime nada.
function runCli(args) {
  const fs = require("fs");
  if (args[0] === "--next-business-day" || args[0] === "--nbd") {
    console.log(JSON.stringify(getNextBusinessDay(args[1] || null)));
    return;
  }
  const fileArg = args[0] === "--check" ? args[1] : args[0];
  if (!fileArg) {
    main();
    return;
  }
  const txt = fileArg === "-" || fileArg === "--stdin"
    ? fs.readFileSync(0, "utf8")
    : fs.readFileSync(fileArg, "utf8");
  const issues = checkEmail(txt);
  let body = txt.includes("\n\n") ? txt.split("\n\n").slice(1).join("\n\n") : txt;
  body = body.split(SIGNATURE)[0];
  const bodyWords = body.split(/\s+/).filter(Boolean).length;
  const totalWords = txt.split(/\s+/).filter(Boolean).length;
  console.log("ISSUES:", JSON.stringify(issues));
  console.log("bodyWords:", bodyWords, "| totalWords:", totalWords);
  console.log("STATUS:", issues.length === 0 ? "OK" : "ISSUES_FOUND");
}

if (require.main === module) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length > 0) {
    runCli(cliArgs);
  } else {
    main();
  }
}

module.exports = {
  cleanPhone,
  splitAddress,
  wrapParagraph,
  formatEmail,
  getNextBusinessDay,
  checkBusinessDayDates,
  checkEmail,
  formatTrackingLink,
  checkTrackingLinks,
  PRODUCT_LINKS,
  embedProductLinks,
  checkProductLinks,
  generateCompensationLabel,
  generateReturnLabel,
  generateShalemRequest,
  formatZendeskTable,
};
