// Le plan chiffré de WeCall.You : un seul modèle pour le simulateur, les paliers et l'objectif des
// dons, fondé sur le test de charge et sur l'affluence réelle mesurée par le serveur (GET /api/health).
// Tout se règle dans soutien.json (« capacity ») : mesure, seuil de bascule, tarifs.
import { api } from './common.js';

const DAYS = 30;
const tens = (n) => Math.round(n / 10) * 10; // montants des paliers : estimés et arrondis

/** Le modèle : requêtes par seconde, charge de la lune, coût des serveurs à la demande. */
export function model(cap) {
  // Une page de client ouverte vérifie son ticket toutes les 5 s et sa place toutes les 30 s ; la
  // page d'un commerçant se rafraîchit toutes les 10 s.
  const rps = (clients, queues) => clients * cap.client_rps + queues * cap.queue_rps;
  // Prudent : toute la charge mesurée est comptée comme du calcul, alors qu'elle venait surtout du direct.
  const fullRps = rps(cap.waiting, cap.queues) / cap.load;
  const perClient = cap.client_rps + (cap.queue_rps * cap.queues) / cap.waiting;
  const clientsAt = (ratio) => Math.floor((ratio * fullRps) / perClient / 100) * 100;
  // Les pages en direct occupent au plus `live` des `connections` de la lune ; le reste, c'est le calcul.
  const loadOf = (clients, queues) => Math.max(Math.min(clients, cap.live) / cap.connections, rps(clients, queues) / fullRps);
  const e = cap.elastic;
  // Serveurs à la demande : des instances d'un processeur (chacune comme la lune à 75 %) payées à la
  // seconde pendant les heures d'affluence, et la base partagée, active pendant ces mêmes heures.
  // Prix hors taxes : la micro-entreprise ne récupère pas la TVA.
  const elastic = (clients, queues, hours) => {
    const instances = Math.max(1, Math.ceil(rps(clients, queues) / (0.75 * fullRps)));
    const seconds = instances * hours * 3600 * DAYS;
    const containers = (Math.max(0, seconds - e.free_vcpu_s) * e.vcpu_100k + Math.max(0, seconds * e.gb - e.free_gb_s) * e.gb_100k) / 1e5;
    const database = Math.ceil(instances / e.db_instances_per_vcpu) * hours * DAYS * e.db_vcpu_hour + e.db_gb * e.db_gb_month;
    return { instances, month: Math.round((containers + database) * (1 + cap.vat) * 100) / 100 };
  };
  return { rps, loadOf, elastic, comfortable: clientsAt(0.75), switchAt: clientsAt(cap.switch) };
}

/** L'affluence de départ : la réelle (le plus de clients page ouverte ce mois-ci), sinon un exemple. */
export function scenarioOf(usage) {
  if (usage?.pages > 0) {
    const queues = Math.max(1, usage.pagesQueues);
    return { queues, perQueue: Math.max(1, Math.round(usage.pages / queues)), hours: Math.min(24, Math.max(1, Math.round(usage.busyHours))), real: true };
  }
  return { queues: 3, perQueue: 50, hours: 4, real: false }; // un tournoi : trois buvettes
}

/**
 * Les montants du plan pour une affluence : frais du mois, et, pour les paliers, un an d'avance.
 * La bascule vers les serveurs à la demande se fait dès que la lune approche de sa limite : ce palier
 * réunit un an de serveurs dimensionnés pour l'affluence prévue, et au moins pour celle de la bascule.
 */
export function amounts(cfg, scenario) {
  const cap = cfg.capacity;
  const m = model(cap);
  const month = cfg.costs.reduce((sum, c) => sum + c.month, 0);
  const elastic = m.elastic(Math.max(scenario.queues * scenario.perQueue, m.switchAt), scenario.queues, scenario.hours);
  const servers = tens(elastic.month * cap.months);
  const costs = tens((month - cap.month) * cap.months); // tout sauf la lune, remplacée par les serveurs
  return { month, costs, servers, switch: servers, year: costs + servers, switchAt: m.switchAt };
}

/** Montant d'une étape : calculé (« plan » : switch, year) ou écrit dans soutien.json. */
export const targetOf = (stage, plan) => (stage.plan ? plan?.[stage.plan] : (stage.total ?? stage.month));

/** L'affluence réelle du mois (une fois par page). */
let usage;
export function loadUsage() {
  usage ??= api('/health').then((res) => (res.ok ? res : null));
  return usage;
}
