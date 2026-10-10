// Le calcul de l'atelier d'impression (page Soutenir), sans rien du navigateur : testé côté serveur.

/**
 * Le calcul d'un mois. v : les valeurs des curseurs ; fees : frais de paiement (pourcentage, fixe).
 * L'impression tourne pendant qu'on emballe : elle ne prend qu'une part de surveillance du temps de travail,
 * mais chaque imprimante ne tourne que pendant les heures de présence.
 */
export function compute(v, fees) {
  const minutesFor = (items, perHour) => (items && perHour ? (items / perHour) * 60 : 0);
  const printMinutes = minutesFor(v.sheetsA4, v.speedA4) + minutesFor(v.postersA3, v.speedA3) + minutesFor(v.rollTickets, v.speedRoll);
  const staffMinutes = v.minutesOrder + v.supervision * printMinutes;
  const available = Math.max(0, v.hours * 60 - v.minutesDay * v.days);
  const limits = [
    { by: 'staff', cap: staffMinutes ? available / staffMinutes : Infinity },
    v.sheetsA4 > 0 && { by: 'a4', cap: (v.hours * v.speedA4) / v.sheetsA4 },
    v.postersA3 > 0 && { by: 'a3', cap: (v.hours * v.speedA3) / v.postersA3 },
    v.rollTickets > 0 && { by: 'roll', cap: (v.hours * v.speedRoll) / v.rollTickets },
  ].filter(Boolean);
  const bottleneck = limits.reduce((a, b) => (b.cap < a.cap ? b : a));
  const capacity = Math.floor(bottleneck.cap);
  const materials = v.sheetsA4 * v.costA4 + v.postersA3 * v.costA3 + v.rollTickets * v.costRoll + v.packaging;
  const fee = v.price * (fees.percent / 100) + fees.fixed;
  const margin = v.price - materials - fee;
  const sales = v.orders * margin;
  const shopFixed = v.wage + v.company;
  const service = v.server + v.dev;
  const costs = shopFixed + service;
  const result = v.donations + sales - costs;
  return {
    printMinutes,
    staffMinutes,
    capacity,
    bottleneck: bottleneck.by,
    perDay: capacity / v.days,
    load: capacity ? v.orders / capacity : Infinity,
    workHours: (v.orders * staffMinutes + v.minutesDay * v.days) / 60,
    printHours: (v.orders * printMinutes) / 60,
    materials,
    fee,
    margin,
    sales,
    shopFixed,
    service,
    costs,
    result,
    coverServer: v.server ? v.donations / v.server : 1,
    breakEven: margin > 0 ? Math.ceil(shopFixed / margin) : Infinity,
    dream: margin > 0 ? Math.ceil(costs / margin) : Infinity,
    payback: result > 0 ? Math.ceil(v.invest / result) : Infinity,
  };
}
