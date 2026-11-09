#!/usr/bin/env node
/**
 * Monitor de horarios para una agenda de citas de Google Calendar.
 *
 * Renderiza la página con Playwright (el HTML crudo es solo un shell de JS),
 * recoge todos los horarios disponibles y avisa por Telegram los que son nuevos
 * respecto a la revisión anterior.
 *
 * Solo lee el DOM: no reserva, no toca el reCAPTCHA ni los endpoints RPC.
 *
 * Uso:
 *   node monitor.js              una revisión y sale
 *   node monitor.js --loop 10    revisa cada 10 minutos
 *   node monitor.js --test       envía un mensaje de prueba a Telegram
 *   node monitor.js --dry-run    revisa pero imprime el mensaje en vez de enviarlo
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = 'America/Bogota';

/** aria-label de un día SIN cupo ("Martes 10, no hay horarios disponibles"). */
const SIN_CUPO = /no hay horarios disponibles|sin horarios|no appointments? available|no available times?/i;

// ---------------------------------------------------------------- configuración

/** Parser mínimo de .env. No sobreescribe lo que ya exista en el entorno. */
function loadDotEnv() {
  for (const file of [resolve(process.cwd(), '.env'), resolve(HERE, '.env')]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      let value = line.slice(eq + 1).trim();
      const quoted =
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1);
      if (quoted) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
    break; // el .env del directorio actual gana
  }
}

function buildConfig() {
  const monthsAhead = Number.parseInt(process.env.MONTHS_AHEAD ?? '2', 10);
  return {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
    // A propósito sin valor por defecto: la URL de la agenda permite reservar,
    // así que no vive en el repo. Va en el .env local y en un secret.
    url: (process.env.SCHEDULE_URL || '').trim(),
    monthsAhead: Number.isFinite(monthsAhead) && monthsAhead >= 0 ? monthsAhead : 2,
    excludeDates: new Set(
      (process.env.EXCLUDE_DATES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    stateFile: resolve((process.env.STATE_FILE || '').trim() || resolve(HERE, 'state.json')),
    title: (process.env.SCHEDULE_TITLE || '').trim() || 'Agenda de citas',
  };
}

// ------------------------------------------------------------------- utilidades

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const ISO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** epoch ms -> "YYYY-MM-DD" en hora de Bogotá. */
const isoDay = (ms) => ISO_DAY.format(new Date(ms));

const PRETTY = new Intl.DateTimeFormat('es-CO', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
/** epoch ms -> "lun, 9 de nov, 10:00 a. m." */
function pretty(ms) {
  const p = {};
  for (const { type, value } of PRETTY.formatToParts(new Date(ms))) p[type] = value;
  const trim = (s) => (s || '').replace(/\.$/, '');
  const dayPeriod = (p.dayPeriod || '').replace(/\u202f/g, ' ');
  return `${trim(p.weekday)}, ${p.day} de ${trim(p.month)}, ${p.hour}:${p.minute} ${dayPeriod}`.trim();
}

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------- Telegram

async function sendTelegram({ token, chatId }, html) {
  if (!token || !chatId) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN y/o TELEGRAM_CHAT_ID');
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`Telegram respondió ${res.status}: ${body.description || JSON.stringify(body)}`);
  }
  return body;
}

// ---------------------------------------------------------------------- scraping

/**
 * Se ejecuta en el navegador: devuelve las celdas de día y el mes "dominante"
 * de la grilla (muestra 6 semanas e incluye días del mes anterior y del
 * siguiente, así que el mes con más celdas es el que se está viendo).
 */
const READ_GRID = () => {
  const cells = Array.from(document.querySelectorAll('td[data-date]'));
  const days = cells.map((td) => {
    const btn = td.querySelector('button');
    return {
      date: td.getAttribute('data-date') || '',
      label: btn ? btn.getAttribute('aria-label') || btn.textContent || '' : '',
      disabled: !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true',
    };
  });
  const counts = new Map();
  for (const d of days) {
    if (d.date.length < 6) continue;
    const ym = d.date.slice(0, 6);
    counts.set(ym, (counts.get(ym) || 0) + 1);
  }
  let modalMonth = '';
  let best = -1;
  for (const [ym, n] of counts) {
    if (n > best) {
      best = n;
      modalMonth = ym;
    }
  }
  return { days, modalMonth };
};

/** Se ejecuta en el navegador: horarios visibles con su aria-label. */
const READ_SLOTS = () =>
  Array.from(document.querySelectorAll('[data-date-time]'))
    .filter((el) => el.offsetParent !== null && !el.closest('[aria-hidden="true"]'))
    .map((el) => ({
      t: el.getAttribute('data-date-time'),
      label: (el.getAttribute('aria-label') || el.textContent || '').trim(),
    }));

function buildUserAgent(version) {
  const major = String(version || '').split('.')[0] || '131';
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Recorre el mes actual y los `monthsAhead` siguientes, abre cada día con cupo
 * y devuelve un Map de epoch(ms) -> etiqueta.
 */
async function scrapeSlots(cfg) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'es-419',
    timezoneId: TZ,
    viewport: { width: 1360, height: 1000 },
    userAgent: buildUserAgent(browser.version()),
  });
  const page = await context.newPage();

  const slots = new Map();
  try {
    log(`Abriendo ${cfg.url}`);
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    try {
      await page.waitForSelector('td[data-date]', { timeout: 45000, state: 'attached' });
    } catch {
      throw new Error(
        'La página no mostró la grilla del calendario (td[data-date]). ' +
          '¿Cambió el HTML, la agenda ya no existe o Google bloqueó la petición?',
      );
    }

    const visited = new Set();

    for (let m = 0; m <= cfg.monthsAhead; m++) {
      await page.waitForSelector('td[data-date]', { timeout: 20000, state: 'attached' });
      const { days, modalMonth } = await page.evaluate(READ_GRID);

      if (!modalMonth) throw new Error('No pude determinar el mes visible en la grilla');
      if (visited.has(modalMonth)) {
        log(`El mes ${modalMonth} ya se revisó (la navegación no avanzó); corto aquí`);
        break;
      }
      visited.add(modalMonth);

      // Solo los días que pertenecen al mes visible: los días del mes vecino se
      // revisan cuando navegamos a ese mes.
      const delMes = days.filter((d) => d.date.startsWith(modalMonth));
      const conCupo = delMes.filter((d) => !d.disabled && !SIN_CUPO.test(d.label));
      log(
        `Mes ${modalMonth}: ${delMes.length} días, ${conCupo.length} con cupo` +
          (conCupo.length ? ': ' + conCupo.map((d) => Number(d.date.slice(6))).join(', ') : ''),
      );

      for (const d of conCupo) {
        const iso = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`;
        const cell = page.locator(`td[data-date="${d.date}"] button`).first();
        try {
          await cell.click({ timeout: 10000 });
        } catch (err) {
          log(`  ! no pude hacer clic en ${iso}: ${String(err.message).split('\n')[0]}`);
          continue;
        }
        // Espera a que aparezca al menos un horario de ESE día: el panel muestra
        // ~3 días, así que pueden quedar horarios del día anterior en el DOM.
        try {
          await page.waitForFunction(
            (target) =>
              Array.from(document.querySelectorAll('[data-date-time]')).some((el) => {
                const t = Number(el.getAttribute('data-date-time'));
                if (!Number.isFinite(t)) return false;
                return (
                  new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'America/Bogota',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                  }).format(new Date(t)) === target
                );
              }),
            iso,
            { timeout: 12000 },
          );
        } catch {
          log(`  ! ${iso} aparecía con cupo pero no cargó ningún horario`);
          continue;
        }

        const found = await page.evaluate(READ_SLOTS);
        let nuevos = 0;
        for (const s of found) {
          const t = Number(s.t);
          if (!Number.isFinite(t) || t <= 0) continue;
          if (!slots.has(t)) nuevos++;
          slots.set(t, s.label);
        }
        log(`  ${iso}: ${found.length} horarios visibles (${nuevos} no vistos antes)`);
      }

      if (m < cfg.monthsAhead) {
        const next = page
          .locator('button[aria-label="Mes siguiente"], button[aria-label="Next month"]')
          .first();
        if ((await next.count()) === 0) {
          log('No hay botón de mes siguiente; corto aquí');
          break;
        }
        if (await next.isDisabled().catch(() => false)) {
          log('El botón de mes siguiente está deshabilitado; corto aquí');
          break;
        }
        await next.click();
        try {
          await page.waitForFunction(
            (prev) => {
              const counts = new Map();
              for (const td of document.querySelectorAll('td[data-date]')) {
                const date = td.getAttribute('data-date') || '';
                if (date.length < 6) continue;
                const ym = date.slice(0, 6);
                counts.set(ym, (counts.get(ym) || 0) + 1);
              }
              let modal = '';
              let best = -1;
              for (const [ym, n] of counts) {
                if (n > best) {
                  best = n;
                  modal = ym;
                }
              }
              return Boolean(modal) && modal !== prev;
            },
            modalMonth,
            { timeout: 15000 },
          );
        } catch {
          log('El calendario no cambió de mes a tiempo; corto aquí');
          break;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return slots;
}

// ------------------------------------------------------------------------ estado

async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const slots = Array.isArray(parsed && parsed.slots) ? parsed.slots : [];
    return {
      updatedAt: (parsed && parsed.updatedAt) || null,
      slots: new Set(slots.map(Number).filter(Number.isFinite)),
    };
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Aviso: no pude leer ${file} (${err.message}); empiezo de cero`);
    return { updatedAt: null, slots: new Set() };
  }
}

/**
 * Guarda el estado solo si el conjunto de horarios cambió. Así el archivo no se
 * reescribe en cada revisión y en GitHub Actions no se genera un commit vacío
 * cada 10 minutos: `git diff` solo marca cambios cuando de verdad cambió algo.
 */
async function writeState(file, epochs, previos, { force = false } = {}) {
  const sorted = [...epochs].sort((a, b) => a - b);
  const iguales =
    previos.size === sorted.length && sorted.every((t) => previos.has(t));
  if (iguales && !force) {
    log('Estado sin cambios; no reescribo state.json.');
    return false;
  }
  const payload = {
    updatedAt: new Date().toISOString(),
    timeZone: TZ,
    count: sorted.length,
    slots: sorted,
    legible: sorted.map(pretty),
  };
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return true;
}

// ----------------------------------------------------------------------- mensaje

function buildMessage(cfg, { nuevos, conocidos }) {
  const MAX_CONOCIDOS = 12;
  const lines = [
    '🏍️ <b>¡Horarios nuevos!</b>',
    `<i>${escapeHtml(cfg.title)}</i>`,
    '',
    `🆕 <b>Nuevos (${nuevos.length}):</b>`,
    ...nuevos.map((t) => `• ${escapeHtml(pretty(t))}`),
  ];

  if (conocidos.length) {
    lines.push('', `📋 <b>Seguían disponibles (${conocidos.length}):</b>`);
    lines.push(...conocidos.slice(0, MAX_CONOCIDOS).map((t) => `• ${escapeHtml(pretty(t))}`));
    if (conocidos.length > MAX_CONOCIDOS) {
      lines.push(`<i>…y ${conocidos.length - MAX_CONOCIDOS} más</i>`);
    }
  }

  lines.push('', `🔗 <a href="${escapeHtml(cfg.url)}">Agendar aquí</a>`);
  return lines.join('\n');
}

// -------------------------------------------------------------------- revisiones

/** Una revisión completa. Lanza si la página falla. */
async function runCheck(cfg, { dryRun = false } = {}) {
  const found = await scrapeSlots(cfg);
  const ahora = Date.now();

  const vigentes = [];
  let pasados = 0;
  let excluidos = 0;
  for (const t of found.keys()) {
    if (t <= ahora) {
      pasados++;
      continue;
    }
    if (cfg.excludeDates.has(isoDay(t))) {
      excluidos++;
      continue;
    }
    vigentes.push(t);
  }
  vigentes.sort((a, b) => a - b);

  log(
    `Total: ${found.size} horarios encontrados → ${vigentes.length} vigentes ` +
      `(${pasados} pasados, ${excluidos} excluidos por EXCLUDE_DATES)`,
  );

  const previo = await readState(cfg.stateFile);
  const primeraVez = previo.updatedAt === null;
  const nuevos = vigentes.filter((t) => !previo.slots.has(t));
  const conocidos = vigentes.filter((t) => previo.slots.has(t));

  // El estado se guarda completo, no acumulado: si un horario desaparece y
  // luego se libera otra vez, vuelve a contar como nuevo.
  // `force` en la primera ejecución para que el archivo exista siempre, incluso
  // si no hay ningún horario: sin eso, la corrida siguiente volvería a creerse
  // la primera y no avisaría del primer horario que aparezca.
  if (dryRun) {
    log('DRY RUN: no toco state.json.');
  } else {
    await writeState(cfg.stateFile, vigentes, previo.slots, { force: primeraVez });
  }

  if (!nuevos.length) {
    log('Sin horarios nuevos.');
    return { nuevos, conocidos, enviado: false };
  }

  if (primeraVez) {
    log(
      `Primera ejecución (no existía ${cfg.stateFile}): ${nuevos.length} horarios guardados ` +
        'como línea base, sin aviso.',
    );
    return { nuevos, conocidos, enviado: false, primeraVez: true };
  }

  const msg = buildMessage(cfg, { nuevos, conocidos });
  if (dryRun) {
    const sep = '─'.repeat(60);
    log(`DRY RUN — mensaje que se enviaría:\n${sep}\n${msg}\n${sep}`);
    return { nuevos, conocidos, enviado: false, dryRun: true };
  }

  await sendTelegram(cfg, msg);
  log(`Aviso enviado por Telegram: ${nuevos.length} horarios nuevos.`);
  return { nuevos, conocidos, enviado: true };
}

async function runLoop(cfg, minutos, opts) {
  const intervalo = Math.max(1, minutos) * 60000;
  log(`Modo loop: revisión cada ${minutos} min. Ctrl+C para salir.`);
  let fallosSeguidos = 0;

  for (;;) {
    try {
      await runCheck(cfg, opts);
      fallosSeguidos = 0;
    } catch (err) {
      fallosSeguidos++;
      log(`ERROR (${fallosSeguidos} seguidos): ${err.message}`);
      if (fallosSeguidos >= 3) {
        const aviso =
          `⚠️ <b>El monitor falló ${fallosSeguidos} veces seguidas</b>\n\n` +
          `<code>${escapeHtml(String(err.message).slice(0, 500))}</code>\n\n` +
          `Sigo intentando cada ${minutos} min.`;
        try {
          await sendTelegram(cfg, aviso);
          log('Aviso de fallo enviado por Telegram.');
        } catch (e2) {
          log(`Tampoco pude avisar por Telegram: ${e2.message}`);
        }
        fallosSeguidos = 0; // reinicia para no spamear en cada revisión
      }
    }
    await sleep(intervalo);
  }
}

// --------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { mode: 'once', minutes: 10, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--loop') {
      opts.mode = 'loop';
      const n = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(n) && n > 0) {
        opts.minutes = n;
        i++;
      }
    } else if (a.startsWith('--loop=')) {
      opts.mode = 'loop';
      const n = Number.parseInt(a.slice('--loop='.length), 10);
      if (Number.isFinite(n) && n > 0) opts.minutes = n;
    } else if (a === '--test') {
      opts.mode = 'test';
    } else if (a === '--dry-run' || a === '--dry') {
      opts.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      opts.mode = 'help';
    } else {
      console.error(`Argumento desconocido: ${a}`);
      opts.mode = 'help';
    }
  }
  return opts;
}

const HELP = `
Monitor de horarios de una agenda de citas de Google Calendar

  node monitor.js              una revisión y sale (exit 1 si la página falla)
  node monitor.js --loop 10    revisa cada 10 minutos
  node monitor.js --test       envía un mensaje de prueba a Telegram
  node monitor.js --dry-run    revisa pero imprime el mensaje en vez de enviarlo

Variables de entorno (o archivo .env en el directorio actual):
  SCHEDULE_URL         obligatorio: URL de la agenda a monitorear
  TELEGRAM_BOT_TOKEN   obligatorio para enviar
  TELEGRAM_CHAT_ID     obligatorio para enviar
  MONTHS_AHEAD         meses a revisar además del actual (por defecto 2)
  EXCLUDE_DATES        fechas a ignorar, YYYY-MM-DD separadas por coma
  SCHEDULE_TITLE       título que aparece en el mensaje
  STATE_FILE           ruta del estado (por defecto state.json junto al script)
`;

async function main() {
  loadDotEnv();
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'help') {
    console.log(HELP.trim());
    process.exit(0);
  }

  const cfg = buildConfig();
  if (!cfg.url) {
    throw new Error(
      'Falta SCHEDULE_URL (la URL de la agenda de Google Calendar). ' +
        'Ponla en el .env local o, en GitHub Actions, como secret del repo.',
    );
  }
  log(
    `Config: meses=actual+${cfg.monthsAhead}, ` +
      `excluidas=[${[...cfg.excludeDates].join(', ') || 'ninguna'}], estado=${cfg.stateFile}`,
  );

  if (opts.mode === 'test') {
    await sendTelegram(
      cfg,
      '✅ <b>Monitor de horarios activo</b>\n\n' +
        `Agenda: <i>${escapeHtml(cfg.title)}</i>\n` +
        `Zona horaria: <code>${TZ}</code>\n` +
        `Revisando: mes actual + ${cfg.monthsAhead}\n` +
        `Fechas excluidas: <code>${escapeHtml([...cfg.excludeDates].join(', ') || 'ninguna')}</code>\n\n` +
        `🔗 <a href="${escapeHtml(cfg.url)}">Agendar aquí</a>`,
    );
    log('Mensaje de prueba enviado.');
    return;
  }

  if (opts.mode === 'loop') {
    await runLoop(cfg, opts.minutes, { dryRun: opts.dryRun });
    return;
  }

  await runCheck(cfg, { dryRun: opts.dryRun });
}

main().catch((err) => {
  const msg = (err && err.message) || String(err);
  console.error(`[${new Date().toISOString()}] FALLÓ: ${msg}`);
  // El stack solo estorba para errores esperables (faltan credenciales, la
  // página no cargó). Con DEBUG=1 se imprime completo.
  if (process.env.DEBUG && err && err.stack) console.error(err.stack);
  process.exit(1);
});
