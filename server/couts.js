// Ce que le projet a coûté, mesuré : le temps du fondateur, les jetons d'IA et leur prix (part de
// l'abonnement, et tarif de l'API pour comparer), évolution par évolution (enregistrements Git).
// Lit les journaux de Claude Code de cet ordinateur (~/.claude/projects) et n'en garde que des
// totaux, jamais le contenu des conversations. Écrit public/couts.json, publié tel quel.
//
//   node couts.js         met à jour public/couts.json (et automatiquement à la fin de chaque
//                         session Claude Code ouverte dans le dépôt : .claude/settings.json)
//
// Une session compte pour le projet si elle a travaillé au moins une fois dans le dossier du dépôt ;
// ses sous-agents la suivent. Tarifs et abonnement : « ai » dans public/soutien.json.
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IDLE = 10 * 60_000; // au-delà de 10 min sans message, le fondateur n'est plus devant l'écran
const BINARY = /\.(png|jpe?g|webp|gif|ico|woff2?|pdf)$/i;

/** Chemin comparable d'un système à l'autre : « C:\Users\a » et « /c/Users/a » donnent « c:/users/a ». */
export const normalize = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/').replace(/\/+$/, '').toLowerCase();

/** Un message tapé par le fondateur (texte, texte collé ou capture), pas un message de l'outil. */
export function isHuman(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  if (blocks.some((block) => block.type === 'tool_result')) return false;
  return blocks.some((block) => block.type === 'image' || (block.type === 'text' && block.text.trim() && !/^\s*(<(ide_|system-reminder|command-|local-command)|\[Request interrupted)/.test(block.text)));
}

/** Un journal : ses réponses (jetons), ses horodatages, ses dossiers de travail, les messages tapés. */
export async function readLog(file) {
  const log = { file, replies: [], stamps: [], cwds: new Set(), human: 0 };
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry.timestamp ?? '');
    if (entry.cwd) log.cwds.add(normalize(entry.cwd));
    if (Number.isFinite(at)) log.stamps.push(at);
    if (isHuman(entry)) log.human++;
    const usage = entry.message?.usage;
    // Une réponse est écrite en plusieurs lignes, avec les mêmes jetons : on la garde une fois (par id).
    if (entry.type === 'assistant' && usage && Number.isFinite(at)) log.replies.push({ id: entry.message.id ?? entry.requestId ?? entry.uuid, at, model: entry.message.model, usage });
  }
  return log;
}

/** Les journaux de Claude Code : session principale (« <id>.jsonl ») et sous-agents (« <id>/subagents/ »). */
export function findLogs(root) {
  const logs = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) {
        const subagent = path.basename(path.dirname(full)) === 'subagents';
        const session = subagent ? path.basename(path.dirname(path.dirname(full))) : entry.name.slice(0, -6);
        logs.push({ file: full, session, subagent });
      }
    }
  };
  walk(root);
  return logs;
}

const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Le bilan : logs (lus, avec session et subagent), repo (dossier du dépôt), commits ([{ at, hash,
 * title }] du plus ancien au plus récent), ai (« ai » de soutien.json : prix par million, abonnement).
 */
export function summarize({ logs, repo, commits, ai }) {
  const home = normalize(repo);
  const inRepo = (cwd) => cwd === home || cwd.startsWith(`${home}/`);
  const sessions = new Set(logs.filter((log) => [...log.cwds].some(inRepo)).map((log) => log.session));
  const ours = (log) => sessions.has(log.session);
  const priceOf = (model) => ai.prices[model] ?? Object.values(ai.prices)[0];
  const usdOf = (reply) => {
    const p = priceOf(reply.model);
    const u = reply.usage;
    return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
  };

  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const perDay = new Map(); // jour → { all, ours } en dollars au tarif de l'API, tous projets confondus
  const evolutions = commits.map((commit) => ({ commit: commit.hash, date: day(commit.at), title: commit.title, usd: 0, tokens: 0 }));
  const current = { usd: 0, tokens: 0 }; // depuis le dernier enregistrement
  const seen = new Set();
  let usd = 0;
  let replies = 0;
  for (const log of logs) {
    for (const reply of log.replies) {
      if (seen.has(reply.id)) continue;
      seen.add(reply.id);
      const cost = usdOf(reply);
      const bucket = perDay.get(day(reply.at)) ?? { all: 0, ours: 0 };
      perDay.set(day(reply.at), bucket);
      bucket.all += cost;
      if (!ours(log)) continue;
      bucket.ours += cost;
      const u = reply.usage;
      const count = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      tokens.input += u.input_tokens ?? 0;
      tokens.output += u.output_tokens ?? 0;
      tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
      tokens.cacheRead += u.cache_read_input_tokens ?? 0;
      usd += cost;
      replies++;
      // L'évolution qui l'a enregistrée : le premier enregistrement qui suit la réponse.
      const index = commits.findIndex((commit) => commit.at >= reply.at);
      const target = index < 0 ? current : evolutions[index];
      target.usd += cost;
      target.tokens += count;
    }
  }
  // Abonnement : chaque jour en coûte 1/365 de l'année ; le projet en prend sa part selon l'usage du jour.
  const daily = (ai.subscription_month * 12) / 365;
  const subscription = [...perDay.values()].reduce((sum, d) => sum + (d.ours ? (daily * d.ours) / d.all : 0), 0);
  // Temps du fondateur : les sessions principales, pauses de plus de 10 min exclues.
  const stamps = logs.filter((log) => ours(log) && !log.subagent).flatMap((log) => log.stamps).sort((a, b) => a - b);
  const active = stamps.slice(1).reduce((sum, at, i) => sum + (at - stamps[i] <= IDLE ? at - stamps[i] : 0), 0);
  const days = new Set(stamps.map(day));
  return {
    since: stamps.length ? day(stamps[0]) : null,
    days: days.size,
    hours: round(active / 3_600_000, 1),
    messages: logs.filter((log) => ours(log) && !log.subagent).reduce((sum, log) => sum + log.human, 0),
    replies,
    tokens,
    usd: round(usd),
    subscription: round(subscription),
    evolutions: evolutions.map((e) => ({ ...e, usd: round(e.usd) })),
    current: { usd: round(current.usd), tokens: current.tokens },
  };
}

/** Les enregistrements Git du dépôt, du plus ancien au plus récent. */
export function gitCommits(repo) {
  const out = execFileSync('git', ['log', '--reverse', '--format=%at%x09%h%x09%s'], { cwd: repo, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean).map((line) => {
    const [at, hash, ...title] = line.split('\t');
    return { at: Number(at) * 1000, hash, title: title.join('\t') };
  });
}

/** Lignes des fichiers suivis par Git (hors images et polices). */
export function countLines(repo) {
  const files = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter((file) => file && !BINARY.test(file));
  return files.reduce((sum, file) => {
    try {
      return sum + readFileSync(path.join(repo, file), 'utf8').split('\n').length;
    } catch {
      return sum; // fichier supprimé mais pas encore enregistré
    }
  }, 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const soutien = JSON.parse(readFileSync(path.join(repo, 'public', 'soutien.json'), 'utf8'));
  const root = process.env.CLAUDE_PROJECTS ?? path.join(homedir(), '.claude', 'projects');
  const logs = [];
  for (const found of findLogs(root)) logs.push({ ...found, ...(await readLog(found.file)) });
  const costs = { updated: new Date().toISOString(), ...summarize({ logs, repo, commits: gitCommits(repo), ai: soutien.ai }), lines: countLines(repo) };
  writeFileSync(path.join(repo, 'public', 'couts.json'), `${JSON.stringify(costs, null, 1)}\n`);
  console.log(`couts.json : ${costs.hours} h, ${costs.evolutions.length} évolutions, ${costs.usd} $ au tarif de l'API, ${costs.subscription} € d'abonnement.`);
}
