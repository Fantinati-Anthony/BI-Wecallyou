// Ce que le projet a coûté : lecture des journaux de Claude Code, réponses comptées une fois, sessions
// du projet seulement (et leurs sous-agents), temps sans les pauses, part de l'abonnement selon
// l'usage du jour, coût réel de chaque évolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findLogs, readLog, summarize, normalize, isHuman } from '../couts.js';

const T0 = Date.parse('2026-10-09T10:00:00Z');
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const reply = (id, minutes, cwd, output, model = 'm') => ({ type: 'assistant', timestamp: at(minutes), cwd, message: { id, model, usage: { input_tokens: 0, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
const said = (minutes, cwd, content) => ({ type: 'user', timestamp: at(minutes), cwd, message: { content } });
const jsonl = (file, entries) => writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\nligne abîmée\n`);

test('chemins et messages tapés', () => {
  assert.equal(normalize('C:\\Users\\Antho\\ticket-notif\\'), 'c:/users/antho/ticket-notif');
  assert.equal(normalize('/c/Users/antho/ticket-notif'), 'c:/users/antho/ticket-notif');
  assert.equal(isHuman({ type: 'user', message: { content: 'ajoute un simulateur' } }), true);
  assert.equal(isHuman({ type: 'user', message: { content: [{ type: 'image' }] } }), true); // une capture
  assert.equal(isHuman({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), false);
  assert.equal(isHuman({ type: 'user', isCompactSummary: true, message: { content: 'This session…' } }), false);
  assert.equal(isHuman({ type: 'user', message: { content: '<system-reminder>…' } }), false);
  assert.equal(isHuman({ type: 'user', message: { content: '[Request interrupted by user]' } }), false);
});

test('coûts : réponses comptées une fois, projet seul, pauses exclues, abonnement partagé, coût par évolution', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wcy-couts-'));
  try {
    const repo = 'C:\\Users\\a\\ticket-notif';
    mkdirSync(path.join(root, 'proj', 's1', 'subagents'), { recursive: true });
    mkdirSync(path.join(root, 'autre'));
    jsonl(path.join(root, 'proj', 's1.jsonl'), [
      said(0, 'C:\\Users\\a', 'bonjour'), // la session commence hors du dépôt…
      reply('r1', 1, 'C:\\Users\\a', 1000),
      reply('r1', 1, 'C:\\Users\\a', 1000), // la même réponse, sur deux lignes
      said(3, '/c/Users/a/ticket-notif', 'ajoute le simulateur'), // …puis y travaille : elle compte
      said(3, '/c/Users/a/ticket-notif', [{ type: 'tool_result' }]),
      reply('r2', 4, '/c/Users/a/ticket-notif', 2000),
      said(34, '/c/Users/a/ticket-notif', 'et les curseurs ?'), // 30 min de pause : non comptées
      reply('r3', 35, '/c/Users/a/ticket-notif', 3000),
      reply('r6', 50, '/c/Users/a/ticket-notif', 500), // après le dernier enregistrement : en cours
    ]);
    jsonl(path.join(root, 'proj', 's1', 'subagents', 'agent-x.jsonl'), [reply('r4', 10, 'C:\\ailleurs', 4000)]);
    jsonl(path.join(root, 'autre', 's2.jsonl'), [said(5, 'C:\\autre-projet', 'autre chose'), reply('r5', 5, 'C:\\autre-projet', 10_000)]);

    const logs = [];
    for (const found of findLogs(root)) logs.push({ ...found, ...(await readLog(found.file)) });
    const commits = [
      { at: T0 + 2 * 60_000, hash: 'c1', title: 'Première évolution' },
      { at: T0 + 36 * 60_000, hash: 'c2', title: 'Deuxième évolution' },
    ];
    // 20 $ le million en sortie ; abonnement de 365/12 € par mois : 1 € par jour.
    const ai = { subscription_month: 365 / 12, prices: { m: { input: 4, output: 20, cacheWrite: 8, cacheRead: 0.2 } } };
    const costs = summarize({ logs, repo, commits, ai });

    assert.equal(costs.replies, 5); // r1 une fois, r2, r3, r4 (sous-agent), r6 ; pas r5 (autre projet)
    assert.equal(costs.tokens.output, 1000 + 2000 + 3000 + 4000 + 500);
    assert.equal(costs.usd, 0.21); // 10 500 jetons × 20 $ le million
    assert.equal(costs.messages, 3); // les résultats d'outils ne sont pas des messages
    assert.equal(costs.hours, 0.1); // 1 + 2 + 1 + 1 min ; les pauses de 30 et 15 min ne comptent pas
    assert.equal(costs.days, 1);
    assert.equal(costs.since, '2026-10-09');
    // Le jour : 10 500 jetons pour le projet, 10 000 pour l'autre ; 1 € partagé selon l'usage.
    assert.equal(costs.subscription, Math.round((10_500 / 20_500) * 100) / 100);
    assert.deepEqual(costs.evolutions.map((e) => [e.commit, e.usd, e.tokens]), [['c1', 0.02, 1000], ['c2', 0.18, 9000]]);
    assert.equal(costs.evolutions[0].date, '2026-10-09');
    assert.deepEqual(costs.current, { usd: 0.01, tokens: 500 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
