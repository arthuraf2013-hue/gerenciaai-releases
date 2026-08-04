/**
 * Data de hoje (ou de um Date qualquer) no fuso de São Paulo, nunca em
 * UTC nem no fuso cru da máquina. `.toISOString().slice(0,10)` parece
 * inofensivo mas quebra todo dia entre 21h e meia-noite: nesse
 * intervalo, o horário UTC já virou o dia seguinte (São Paulo é
 * UTC-3), então "Hoje" comparava com a data errada e sumia com vendas
 * da tarde/noite que ainda eram "hoje" de verdade.
 */
export function toISODate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
