/**
 * Tope de pasos de cada grafo por turno (cada nodo ejecutado es un paso). Cada subgrafo tiene el suyo: el grafo
 * principal y cada corrida de un subgrafo cuentan por separado.
 *
 * Desde la fase 10 es la ÚLTIMA barrera: un agente con herramientas corta antes, en el nodo `recover`, al pasar las
 * `MAX_TOOL_ROUNDS` (4) rondas o al repetir una consulta. En el peor caso un subgrafo usa 1 + 4×2 + 1 = 10 pasos
 * (agente, 4 rondas de tools y agente, recover), y el grafo principal, 3 + 2 por tarea (hasta 3 tareas): 9. Con 12
 * hay margen en los dos.
 */
export const AGENT_RECURSION_LIMIT = 12;
