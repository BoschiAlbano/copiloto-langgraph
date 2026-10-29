import { tool } from "@langchain/core/tools";
import { ACTION_SCHEMAS, type ActionName } from "./schemas.js";

// Lo que ve el MODELO de las acciones: nombre, descripción y esquema. Nada más.
// Estas herramientas NO se pasan a ningún ToolNode: cuando el modelo las pide, el grafo arma una propuesta
// y espera la aprobación de la persona. Su función lanza siempre, por si alguien las conectara por error.

const DESCRIPTIONS: Record<ActionName, string> = {
  createAppointment:
    "PROPONE agendar un turno. Necesita el id del cliente (findClient), el barbero, el servicio, el día y la hora. " +
    "La persona tiene que aprobarlo antes de que se haga: no queda agendado hasta entonces.",
  cancelAppointment:
    "PROPONE cancelar un turno agendado y futuro. Necesita el id del turno (listAppointments). " +
    "La persona tiene que aprobarlo antes de que se haga.",
  registerSale:
    "PROPONE registrar una venta de productos (por SKU) y/o servicios. No envíes precios ni total: los calcula el sistema. " +
    "Descuenta stock. La persona tiene que aprobarlo antes de que se haga.",
  adjustStock:
    "PROPONE sumar o restar unidades al stock de un producto (por SKU), con un motivo. " +
    "La persona tiene que aprobarlo antes de que se haga.",
};

const neverRuns = (name: ActionName) => async () => {
  throw new Error(`${name} no se ejecuta como herramienta: es una propuesta que necesita aprobación.`);
};

export const ACTION_DEFINITIONS = (Object.keys(ACTION_SCHEMAS) as ActionName[]).map((name) =>
  tool(neverRuns(name), { name, description: DESCRIPTIONS[name], schema: ACTION_SCHEMAS[name] }),
);
