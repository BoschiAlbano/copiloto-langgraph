// Textos fijos de las ramas que todavía no existen. No pasan por ningún modelo.

export const ACTION_STUB_MESSAGE =
  "Entendí que querés hacer un cambio (agendar, cancelar, registrar una venta o ajustar stock). " +
  "Todavía no puedo hacerlo: esa función llega en la fase 5, con tu aprobación antes de modificar nada. " +
  "Por ahora puedo consultar turnos, clientes, ventas y stock.";

export const REPORT_STUB_MESSAGE =
  "Entendí que querés un reporte que junte varias fuentes. Todavía no lo armo: llega en la fase 6. " +
  "Mientras tanto podés pedirme los datos de a uno: las ventas de un período, los turnos de un día " +
  "o los productos con stock bajo.";
