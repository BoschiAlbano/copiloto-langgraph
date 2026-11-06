# Versiones de prompts para comparar

Cada carpeta es una versión: tiene solo los archivos que cambian respecto de `src/graph/prompts/`. Se comparan contra los actuales con el set de evaluación de la fase 11:

```powershell
npm run eval -- --compare evals/prompts/<carpeta> --runs 3
```

Lo que dio cada una (Haiku, 3 corridas, noviembre de 2026):

| Carpeta | Qué cambia | Resultado |
| --- | --- | --- |
| `reporte-mes-equivocado` | El planificador de reportes manda «el mes» al mes anterior (una regla mal escrita, a propósito) | Reportes: 12/12 → 9/12. Cambió R4 («Haceme un reporte del mes»): 3/3 → 0/3, con el período equivocado como motivo |
| `chat-con-acciones` | El prompt de charla dice lo que el copiloto ya hace, sin «próximamente» | Charla y aclaración: 9/12 → 12/12. H1 («¿qué podés hacer?») pasa de 0/3 a 3/3. Es la corrección candidata del error que detecta H1 |
| `router-igual` | Nada: una copia exacta del router | Sin cambios estables, como corresponde |
| `router-una-tarea` | El router sin su sección «Cuándo separar en tareas», con la orden de devolver una sola tarea | **Sin cambios**: el router siguió separando los pedidos mixtos. La primera línea del prompt y la descripción del esquema de salida («las partes del último mensaje, en el orden en que se pidieron») ya lo piden. La sección era redundante y sacarla ahorra unos 200 tokens por turno |
| `router-sin-seccion` | El router sin su sección «Cuándo separar en tareas» (sacada del todo, sin reemplazo) | Set completo, 3 corridas: 107/108 en los dos lados, ningún caso cambió; −490 tokens de entrada por caso. **Adoptada** el 6 de noviembre, junto con `chat-con-acciones` |

`chat-con-acciones` y `router-sin-seccion` ya son los prompts actuales: compararlas hoy no muestra diferencias. Quedan como registro.
