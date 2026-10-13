# Propuesta: plataforma de huésped propia (vs. Enso Connect)

**Estado: planeación, nada construido.** El jefe quiere replicar Enso Connect
completo — no solo cerraduras — porque alguien más (otro anfitrión/competidor) lo
usa, sin que él mismo sepa el detalle de qué hace. Este documento cubre **todo** lo
que vende Enso, no solo accesos, y para cada pieza dice si construirla nosotros
mismos tiene sentido o si es mejor dejarla donde ya está (Hostaway) o no hacerla.
Principio que puso el jefe y que guía todo: **quiere algo que seamos dueños, no una
integración** — ni pagar a Enso, ni depender de un intermediario que no controlamos.

## 1. Qué vende Enso Connect, completo

Es un "sistema operativo de experiencia del huésped" sobre un PMS existente
(Hostaway, Guesty, etc. — no lo reemplaza, se le pega encima). Seis piezas:

1. **Boarding Pass** — un link único por reserva (compatible con Apple Wallet) que
   junta check-in, verificación, guía digital y upsells en una sola pantalla para
   el huésped.
2. **Verificación de identidad + depósito de garantía** — confirma identidad antes
   de entregar acceso; un flujo liga el depósito al desbloqueo de la chapa (no
   abre hasta que el huésped paga/verifica).
3. **Guía digital (guidebook)** — wifi, reglas de la casa, recomendaciones locales,
   instrucciones — ya es una pantalla dentro del Boarding Pass.
4. **Upsells + marketing de afiliados** — early check-in, late check-out, limpieza
   extra, tours de terceros con comisión (~5% reportado).
5. **Bandeja unificada con IA** — SMS, correo, WhatsApp y el chat de Airbnb en un
   solo lugar, con respuestas automáticas (Enso dice hasta 80%; un caso citado real
   fue 68–75%) y un motor de reglas "si pasa X en la estadía, hacer Y".
6. **CRM de huéspedes** — historial por persona entre reservas.
7. **Cerraduras y sensores inteligentes** — códigos de acceso (ya cubierto abajo) y
   sensores de ruido (Minut, NoiseAware): si detectan ruido, mandan un recordatorio
   de reglas al huésped y escalan si sigue.

**Precio reportado (sin confirmar, fuentes de terceros no coinciden):** entre
US$100–525/mes por cuenta (Capterra/reseñas) o US$9–16/listing/mes, más ~5% de
comisión sobre upsells y un cargo de instalación ~US$300. Con 22 unidades activas
esto es, en el peor caso, varios miles de dólares al año **más** un porcentaje de
cualquier venta adicional — útil para justificarle al jefe el "build vs. buy".

## 2. Qué ya existe en Kaizen OS para lo que no es cerradura

No es solo las chapas lo que ya tenemos parcialmente — hay piezas de infraestructura
reusable para casi todo lo de arriba:

- **Mensajería saliente propia**: `functions/_lib/quo.ts` ya manda SMS por
  QUO/OpenPhone (`QUO_API_KEY`, `QUO_FROM`), con un modo "staged" (se arma el
  mensaje, se ve qué diría, y no se manda hasta que alguien lo active). Hoy se usa
  para alertas internas desde `cron.ts`, no para huéspedes — pero es el canal que
  evitaría pagarle a Enso por mandar SMS.
- **Motor de reglas / automatización, en espíritu**: el clock de Slack (`docs/modules/slack.md`)
  ya dispara mensajes por hora/evento (limpieza del día, alertas de Host Notes);
  es el mismo patrón que el "if-this-then-that" de Enso, solo que hoy apunta al
  equipo, no al huésped.
- **Links públicos auto-autenticados sin exponer toda la app**: el patrón de
  `/report#i=<token>` y `/crew` (Access Bypass + token, §134) es exactamente el
  mecanismo que necesitaría un "Boarding Pass" — un link de un solo uso por
  reserva, sin cuenta, que expira.
- **Datos del huésped y de la reserva**: ya vienen de Hostaway (agreement, ID
  status, fechas) — ver `docs/modules/guests.md`. Un CRM de huéspedes sería
  mayormente una vista nueva sobre datos que ya se sincronizan, no una fuente nueva.
- **Cifrado de credenciales de terceros**: `functions/_lib/crypto.ts` ya es el
  patrón para guardar cualquier API key nueva (verificación de identidad, pagos,
  sensores) sin reinventar nada.

Lo que **no** existe y sí sería nuevo de cero: cobro de pagos (upsells), cualquier
verificación de identidad real (hoy es solo un estado que reporta Hostaway, no una
validación), y cualquier sensor físico de ruido (no hay hardware instalado).

## 3. La brecha, pieza por pieza

| Pieza de Enso | Hoy en Kaizen OS | Para igualarlo |
|---|---|---|
| Código de acceso (ver documento de cerraduras más abajo) | Código fijo manual | Generado/revocado por persona y por reserva |
| Guía digital del huésped | No existe una pantalla pública | Página por unidad con wifi/reglas/recomendaciones |
| Verificación de identidad | Hostaway reporta si subió ID; nadie lo valida | Replicarlo bien es un producto de compliance aparte |
| Depósito de garantía | No existe | Necesita procesador de pagos |
| Upsells | No existe | Catálogo + cobro (pagos) |
| Bandeja unificada + IA | Hostaway ya unifica canales de reserva; QUO existe para SMS saliente | Juntar todo + responder con IA es trabajo nuevo grande |
| CRM de huéspedes | Datos ya están en Hostaway, sin vista propia | Vista nueva, dato ya disponible — barato |
| Sensores de ruido | No hay hardware | Comprar sensores + API del fabricante |

## 4. Viabilidad y "¿somos dueños?" por pieza

| Pieza | ¿Viable siendo dueños? | Por qué |
|---|---|---|
| Guía digital del huésped | **Sí, fácil** | Es solo contenido + el patrón de link público que ya existe. Cero dependencia externa. |
| CRM de huéspedes | **Sí, fácil** | El dato ya está sincronizado de Hostaway; es una pantalla nueva, no una integración nueva. |
| Motor de reglas por etapa de estadía | **Sí** | Generaliza el clock de Slack que ya existe; mismo patrón, más disparadores. |
| Mensajería saliente (SMS) a huéspedes | **Sí** | QUO/OpenPhone ya está cableado; falta solo decidir usarlo con huéspedes, no solo el equipo. |
| Respuestas automáticas con IA al huésped | **Parcial, con cuidado** | Técnicamente viable (ya se usa Gemini en finance), pero un bot respondiéndole mal a un huésped real es un riesgo de servicio distinto a sugerir una tarifa — recomendable solo con revisión humana al principio. |
| Bandeja unificada multicanal (WhatsApp/Airbnb/SMS en un solo hilo) | **Parcial** | WhatsApp Business API y el chat de Airbnb sí son integraciones de verdad con un tercero — ahí "dueño" solo llega hasta donde el canal lo permite; no hay forma de evitarlo, tampoco Enso lo evita. |
| Upsells (catálogo y lógica) | **Sí** la lógica; el cobro, **probablemente ya resuelto** | El catálogo, las reglas de oferta y el seguimiento son propios. El cobro necesita un procesador — pero el negocio ya tiene Stripe conectado a través de Hostaway (Hostaway Payments), así que no se parte de cero. **Falta confirmar** si la API de Hostaway deja cobrar un cargo nuevo (el upsell) sobre esa misma cuenta, o si Kaizen tendría que abrir su propio cobro en paralelo con la misma cuenta de Stripe. De cualquier forma, el impedimento es mucho más chico de lo que parecía. |
| Depósito de garantía | **Sí, probablemente** | Mismo punto que arriba: el Stripe ya existe vía Hostaway; es cuestión de confirmar el camino de API, no de contratar un procesador nuevo. |
| Verificación de identidad real (no solo "¿subió algo?") | **No recomendado construir propio** | Validar un documento de identidad (OCR + detección de fraude + biometría) es un producto de cumplimiento regulado por sí mismo (KYC), no una feature de un fin de semana; el riesgo legal de hacerlo mal (aceptar una ID falsa, guardar datos sensibles mal) supera el beneficio de "ser dueños" aquí. Mejor: seguir con el estado de Hostaway + revisión humana, como hoy. |
| Sensores de ruido (Minut/NoiseAware) | **Sí la integración, no el hardware** | Ambos fabricantes tienen API propia (vía Seam o directa) más abierta que la de Allegion/Schlage — la parte de software es razonable de ser dueños; lo que falta es comprar y mantener sensores físicos, una decisión de capital aparte, no de software. |

## 5. Impedimentos (agregados a los de cerraduras)

1. **Pagos — más chico de lo que parecía.** El negocio ya tiene Stripe conectado
   vía Hostaway Payments (no hay que contratar nada nuevo). Sigue sin existir "ser
   dueños al 100%" de un pago — nadie lo es, ni Enso — pero aquí el impedimento es
   confirmar el camino de API (¿Hostaway deja cobrar un cargo nuevo sobre esa
   cuenta, o toca un cobro aparte con las mismas credenciales de Stripe?), no
   conseguir un procesador desde cero.
2. **Verificación de identidad es un problema legal, no solo técnico** — construirla
   mal (aceptar documentos falsos, guardar datos de identidad sin el cuidado debido)
   es peor que no tenerla. Recomendación: no replicarla; Hostaway ya cubre lo
   mínimo viable para 22 unidades.
3. **IA respondiéndole directo a un huésped** es un salto de riesgo frente a los
   usos actuales de IA en Kaizen (sugerencias de precio con aprobación humana,
   §roadmap) — un huésped enojado recibiendo una respuesta automática mala es un
   problema de reputación inmediato, no una fila de hoja de cálculo por corregir.
4. **Sensores de ruido son gasto de capital**, no de software — comprar, instalar
   y mantener hardware en 22+ unidades es una decisión del jefe sobre presupuesto,
   independiente de si el código para leerlos es fácil.
5. **El alcance completo toca prácticamente todos los módulos** (guests, operations,
   finance si hay upsells con ingreso, slack/platform para mensajería, y el de
   cerraduras aparte) — contradice la regla de "un módulo por sesión"; construir
   esto bien significa fragmentarlo en muchas sesiones/fases, no un sprint.
6. **"Todo" sigue sin estar acotado** — antes de tocar código hace falta que el
   jefe diga, con el costo real de Enso (~US$100-500+/mes + 5% de upsells) sobre la
   mesa, cuáles de las 8 piezas de la sección 1 realmente quiere, porque al menos
   dos (verificación real, pagos) no tienen una versión barata de "hazlo tú mismo".

## 6. Diseño propuesto, en orden de "más propio y más barato primero"

**Fase 0 — Guía digital + CRM de huésped (sin vendor, sin pagos, bajo riesgo):**
- Página pública por unidad (reusa el patrón `/report#i=<token>` de link con
  token que expira) con wifi, reglas, recomendaciones — contenido que hoy ya vive
  disperso (Repository, house rules de Hostaway).
- Vista "huésped" sobre lo que Hostaway ya sincroniza (reservas pasadas, ratings,
  notas) — ningún dato nuevo, solo una pantalla. Encaja en el módulo **guests**.

**Fase 1 — Mensajería saliente a huéspedes + motor de reglas (reusa QUO y el clock):**
- Extender `quo.ts` (ya "staged by default", ya probado) para mensajes al huésped,
  no solo al equipo — mismo control de "nada sale hasta que alguien lo prenda".
- Generalizar el patrón del clock de Slack a reglas por etapa de estadía
  (check-in mañana → recordatorio; durante la estadía → encuesta). Módulo **slack**
  + **guests**.

**Fase 2 — Códigos de acceso** (cleaners primero, huéspedes después): como en el
documento de cerraduras — Allegion directo, sin intermediario de pago si se puede.

**Fase 3 — Sensores de ruido**: solo si el jefe decide el gasto de hardware;
software vía la API del fabricante (Minut/NoiseAware), reusando el mismo patrón
de eventos → Slack que ya existe para work orders.

**Fase 4 — Upsells + depósitos** (requiere decisión de procesador de pagos): catálogo
y reglas propias, cobro vía Stripe/Square. Empezar solo si el jefe confirma que
quiere vender upsells, no solo "tener la feature".

**No construir — dejar donde está:** verificación de identidad real (Hostaway +
revisión humana sigue siendo lo razonable para 22 unidades) y bandeja unificada con
IA respondiendo sin supervisión (si se hace, con revisión humana al inicio, no
autónoma desde el día uno).

## 7. Próximos pasos concretos (sin construir nada todavía)

1. Mostrarle al jefe el costo real de Enso (sección 1) contra el de construir cada
   pieza — varias piezas (guía, CRM, mensajería) son casi gratis de ser propias;
   dos (pagos, verificación de ID) no lo son para nadie.
2. Que decida, con eso sobre la mesa, cuáles de las 8 piezas quiere — no es lo
   mismo "todo" antes de ver el desglose que después.
3. En paralelo, lo ya definido para cerraduras: aplicar a la API de Allegion y
   confirmar modelo real de las 26 chapas Schlage (ver sección de cerraduras).
4. Una vez acotado el alcance, partirlo en sesiones por módulo (regla del
   proyecto) empezando por la Fase 0 — es la de menor riesgo y cero dependencia
   nueva.

---

# Anexo: cerraduras y códigos de acceso (detalle técnico)

*(Documento original — detalle de la pieza de cerraduras de la sección 1.7.)*

## A1. Qué ya existe en Kaizen OS hoy para accesos

- `src/lib/unit-access.ts` + `functions/_lib/unit-access.ts`: cruza la unidad
  (dirección/Wi-Fi sincronizados de Hostaway) con su registro del Repository
  (tipo de cerradura, **Cleaner Code**, lockbox, fobs) y arma el paquete de acceso.
- El código del cleaner se guarda a mano en el Repository (`cleaner_code`), no lo
  entrega ninguna cerradura — es un número que el equipo programó una vez en el
  teclado y nunca rota.
- El código de Hostaway (`door_code`) es el de los huéspedes — solo se muestra si no
  hay Cleaner Code, y se aclara que es el de huésped.
- Reparto controlado: el código solo llega al cleaner de la limpieza de **hoy** y al
  link del helper mientras dura (§136); admin y backup nunca salen del servidor.
- **Decisión §136 ya tomada por el jefe**, sin construir aún: *"a code per cleaner
  later, for security (revoke one person without changing everyone's code)"*.

## A2. Dato real del inventario (consultado en Neon)

```
Schlage Smart Lock   26
Access Fob            9
keys                  3
Yale Smart Lock       2
none                  2
```

"Schlage Smart Lock" es una etiqueta libre, no un modelo. Modelos de Schlage y su
API:

- **Encode / Encode Plus** (Wi-Fi): API directa de Allegion — único caso donde
  "ser dueños" sin intermediario es realista.
- **Connect / Connected Keypad** (Z-Wave): sin nube propia, necesitan un hub local.
- **Sense**: sin soporte de terceros conocido.
- **Arrive**: sin API de terceros, descartada.

**No sabemos hoy cuál de las 4 es cada una de las 26** — primer impedimento, barato
de resolver con una visita de campo.

## A3. Viabilidad por pieza

| Pieza | Viable siendo dueños | Notas |
|---|---|---|
| Código por cleaner (Encode Wi-Fi) | **Sí** | API directa de Allegion, cifrado como con Hostaway |
| Código por reserva/huésped (Encode Wi-Fi) | **Sí**, más riesgo | Falla de red = huésped afuera; necesita respaldo |
| Modelos **Connect** (Z-Wave) | **Parcial** | Necesita hub local propio |
| Control remoto / alertas de batería | **Sí**, con la API | Mismo canal que los códigos |
| Reemplazar Yale/Fob/keys por Schlage | Posible, gasto de capital | 14 unidades sin cerradura programable hoy |

## A4. Impedimentos específicos de cerraduras

1. Modelo exacto de las 26 "Schlage" desconocido.
2. API de Allegion es de aprobación manual para negocios, sin plazo garantizado.
3. Seam (el camino rápido) es exactamente la clase de intermediario de pago que el
   jefe no quiere — queda como puente temporal, no como destino.
4. Modelos Z-Wave necesitan hub local (hardware propio o depender de otro tercero
   como SmartThings).
5. 14 unidades (fobs, llaves, Yale) quedan fuera hasta un cambio de hardware.
6. Sin sandbox con cerradura real — cualquier prueba necesita una chapa física.
7. Cruza operations + platform (y guests si se decide incluir huéspedes).

## A5. Camino técnico recomendado

1. Aplicar ya al portal de Allegion (Schlage Home API) como negocio — gratis
   solicitar, corre en paralelo. Mientras se espera, confirmar en campo modelos.
2. Si aprueban: construir directo contra su API — dato, cifrado y código en
   Kaizen OS, cero intermediario de pago.
3. Si no responden en 60-90 días y el negocio necesita avanzar: Seam solo como
   puente documentado, a reemplazar.
4. Modelos Connect: evaluar aparte si vale un hub propio, o dejarlos con el
   código manual actual.
5. Fobs/llaves/Yale: fuera de este proyecto, decisión de capital aparte.

## A6. Diseño (cuando se decida empezar)

Todo el estado en Neon, cifrado como las credenciales de Hostaway
(`functions/_lib/crypto.ts`).

**Fase 1 — código de cleaner por persona:** tabla `lock_devices` (unit_id, marca,
modelo real, device_id, conectividad) + tabla `access_credentials` (lock_device_id,
holder_type, holder_id, código, vigencia, estado). Reemplaza `cleaner_code`
compartido; reusa `AccessBox.tsx`. Módulo **operations** + pieza en **platform**
(Settings → credenciales de Allegion).

**Fase 2 — código por reserva (huésped), si se decide:** disparado desde la
sincronización de Hostaway (`sync.ts`); respaldo explícito (lockbox/código fijo)
para cuando la chapa no responde. Módulo **guests** + operations.

**Fase 3 — control remoto y alertas:** webhook de Allegion → tabla de eventos,
reply opcional en el hilo de Slack (reusa `crew-slack.ts`).

**No construir:** guía de huésped, verificación, upsells aquí — ya están en la
sección 6 del documento principal con su propio diseño.
