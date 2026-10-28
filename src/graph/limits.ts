/**
 * Tope de pasos del grafo por turno (cada nodo ejecutado es un paso).
 *
 * El camino de consulta más corto usa 4: router → agent → tools → agent. Cada ronda de
 * herramientas suma 2. Con 12 caben 4 rondas más la respuesta final (1 + 4×2 + 1 = 10)
 * con margen; con el tope anterior de 10 la fase 2 alcanzaba para lo mismo, pero el router
 * suma un paso. La política completa de reintentos y topes llega en la fase 10.
 */
export const AGENT_RECURSION_LIMIT = 12;
