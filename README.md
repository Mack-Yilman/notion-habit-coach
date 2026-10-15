# Habit Coach para Notion

Bot de Telegram con coach de IA que hace accionable tu plantilla Habit Tracker Pro de Notion.

## Qué hace

- **Avisos por bloque horario**: Notificaciones según tu momento del día (no por hora fija): cada hábito pendiente llega en su propio mensaje con su rango horario, la «Señal» (el disparador) de su Matriz Atómica y su racha.
- **Registro rápido con botones**: cada hábito pendiente llega en su propio mensaje con 5 íconos, en el mismo orden que el Protocolo de la plantilla (solo el primer mensaje del bloque suena). Tocar un ícono guarda ese nivel en Notion y el mensaje queda registrado con un botón ↩️ para deshacer:
  - 💤 **Omitido**
  - 🕯️ **Parcial**
  - ⚡ **Hecho**
  - 🔥 **Superado**
  - 🚀 **Alto impacto**
- **Rachas inteligentes**: Sistema de rachas con 2 congeladores por hábito para proteger tu constancia ante imprevistos.
- **Nunca falles dos veces**: si un hábito falló ayer, su tarjeta de hoy lo marca con «⚠️ Ayer no salió: no falles dos veces» y te propone su versión mínima (el nivel 🕯️ Parcial de su Protocolo), para no encadenar dos fallos.
- **Coach de IA**: Cierre diario nocturno, `/resumen` a cualquier hora, revisión semanal los domingos (con un mapa de 14 días en emojis) y modo de chat libre que comprende lenguaje natural y puede registrar hábitos automáticamente (por ejemplo: «ya fui al gym»). Su tono es cálido y alentador: empieza por lo que sí hiciste. Sabe qué hora es y qué hábitos aún no tocan, por lo que de madrugada hace el balance de ayer en vez de pedirte algo de la noche. También conoce tus últimos 7 días (días completos seguidos, el hábito más constante y el más flojo, recuperaciones y récords cercanos) y recuerda sus últimos 3 mensajes para no repetirse.
- **Alertas de salud**: si algo falla en silencio, el bot te avisa una vez al día, desde las 06:00 para no despertarte, con «🩺 Revisión del bot»: un aviso o el cierre de rachas que falló en todos sus reintentos, Notion que no creó las filas de hoy (recurrencias apagadas) o el coach de IA que falló (por ejemplo, por falta de saldo).

## Cómo funciona

Notion es la **única base de datos** del sistema. El Cloudflare Worker no almacena datos de tus hábitos; solo guarda estado efímero en KV (deduplicación de avisos, memoria corta del chat y del coach, y caché de la Matriz Atómica).

```text
+-------------------+        +-------------------------------+        +-------------------+
|                   |  Sync  |       Cloudflare Worker       |Webhook |                   |
|  Notion           |<------>|        (Habit Coach)          |<------>|  Telegram         |
| (Única base       |        |  • Cron cada 15 min           |        | (Bot / Usuario)   |
|  de datos)        |        |  • Estado efímero en KV       |        |                   |
+-------------------+        +-------------------------------+        +-------------------+
                                             |
                                             | API
                                             v
                                     +-------------------+
                                     |     DeepSeek      |
                                     |  (Coach con IA)   |
                                     +-------------------+
```

## Horario por defecto

Los avisos se programan en hora local según el bloque horario correspondiente. Solo se envía una notificación si existen hábitos pendientes en ese bloque específico.

Para que el chat no se llene, **cada hábito tiene una sola tarjeta viva**: al llegar un bloque nuevo, el bot borra las tarjetas ya registradas, la anterior de un hábito que vuelve a recordar y las del día anterior. Las pendientes que el bloque no repite se quedan para que puedas registrarlas tarde.

**Recordatorio inteligente:** los avisos principales (06:30, 12:30 y 18:30) siempre suenan. Los **últimos llamados** (10:30, 16:30 y 21:30) llegan **en silencio** (sin sonido ni vibración) salvo que haya una racha en riesgo: un hábito pendiente con racha y sin congeladores, que la perdería si no lo haces hoy. En ese caso suenan y lo indican con ⚠️. Así el sonido siempre significa «esto importa».

| Bloque / Slot | Hora local | Descripción |
| --- | --- | --- |
| `manana` | 06:30 | Mañana: incluye madrugada/Dormir, mañana y «durante el día». |
| `manana_ultimo` | 10:30 | Último llamado de la mañana (pendientes de madrugada y mañana). |
| `tarde` | 12:30 | Bloque de la tarde y lo que aún falta de «durante el día». |
| `tarde_ultimo` | 16:30 | Último llamado de la tarde. |
| `noche` | 18:30 | Bloque de la noche. |
| `noche_ultimo` | 21:30 | Último llamado del día (noche + durante el día). |
| `cierre` | 23:00 | Cierre con coach (los domingos incluye la revisión semanal). |
| `procesar` | 03:00 | Procesa las rachas del día anterior (lo marcado de madrugada aún cuenta). |

**De madrugada (00:00 a 03:00) el día anterior sigue abierto:** `/hoy` y `/pendientes` muestran también los «🌒 Pendientes de ayer», y en el chat puedes contarle al coach algo que hiciste ayer. El coach ya cuenta en tu racha lo que cumpliste ayer, aunque se guarde en Notion recién a las 03:00. A las 03:00 el día se cierra: los botones de un día cerrado ya no cambian nada (el bot te avisa y los quita). Las notas del cierre (🧊 congelador usado, 💔 racha perdida, 🏅 récord, 🎁 congelador ganado) llegan con el aviso de las 06:30, aunque no tengas pendientes de la mañana.

## Reglas de racha

- **Día positivo**: Marcar un hábito como 🕯️ Parcial, ⚡ Hecho, 🔥 Superado o 🚀 Alto impacto suma un día a la racha actual.
- **Día negativo**: Dejar un hábito como 💤 Omitido o ⚪ Sin iniciar al cerrar el día gasta un congelador 🧊.
- **Reinicio a cero**: Si un hábito se queda sin congeladores, la racha vuelve a 0.
- **Día neutro**: Si un día no tiene fila creada para ese hábito, se considera neutro (ni suma ni gasta congeladores).
- **Recuperación de congeladores**: Cada hábito empieza con 2 congeladores. Ganas 1 congelador adicional cada 7 días seguidos de racha, hasta un máximo de 2.
- **Registro en Notion**: Las rachas se guardan en cada fila diaria de «Hábitos», en 4 columnas que crea el asistente: `Racha`, `Mejor racha`, `Congeladores` y `Racha cerrada`. La fila de cada día cerrado guarda cómo quedó la racha ese día (tienes el historial día a día), y a las 03:00 la fila de hoy recibe la racha con la que empiezas, para que la veas en tus vistas de Notion.

## Costos

- **Cloudflare Workers**: Plan gratuito ($0).
- **Telegram Bot API**: Gratis ($0).
- **DeepSeek**: Modelo `deepseek-flash` a ~$0.15 por millón de tokens de entrada y ~$0.60 por millón de tokens de salida fuera de hora pico. Representa menos de $0.30 al mes con uso normal; recargar $2 alcanza para meses.
- **Respaldo gratuito**: Si no hay clave de DeepSeek o si falla, usa Cloudflare Workers AI gratis (modelo Gemma 4, con el razonamiento apagado para que responda rápido y no agote los tokens). Si este también falla, envía un resumen fijo sin IA. En el cierre de las 23:00, el bot espera a DeepSeek hasta 45 s antes de pasar al respaldo.

## Requisitos

- Cuenta de Notion.
- Cuenta de Telegram.
- Cuenta de Cloudflare (gratis).
- Node.js 20+.
- Git.

## Instalación paso a paso

### 1) Duplicar la plantilla de Notion

Abre la plantilla **[Habit Tracker Pro](https://mack-yilman.notion.site/Habit-Tracker-Pro-Template-3f727351c3678036852dca043ff7b017)** de Mack Chirinos y pulsa **Duplicar** (arriba a la derecha) para copiarla a tu Notion.

La copia trae los hábitos de ejemplo con la **repetición apagada**, para que no se creen filas antes de que elijas los tuyos. Antes de seguir, actívala en los hábitos que vayas a usar: ver [Activar recurrencias y agregar hábitos](#activar-recurrencias-y-agregar-hábitos).

### 2) Crear una integración interna de Notion

1. Entra a [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations).
2. Crea una integración interna con las capacidades de: **leer**, **actualizar** e **insertar contenido**.
3. Copia el token secreto de la integración.
4. Entra a tu página «Habit Tracker Pro» en Notion, haz clic en el menú superior (**•••**) → **Conexiones** y añade tu integración.

### 3) Crear el bot con @BotFather

1. Inicia una conversación con [@BotFather](https://t.me/BotFather) en Telegram.
2. Envía el comando `/newbot`.
3. Escribe un nombre para el bot y luego un usuario único terminado en `bot` (por ejemplo: `mi_habit_coach_bot`).
4. Copia el token generado. No lo compartas con nadie.
5. *(Recomendado)* Configura su descripción con `/setdescription` y su imagen con `/setuserpic`.

### 4) Obtener la clave de DeepSeek (opcional)

1. Crea una cuenta en [https://platform.deepseek.com](https://platform.deepseek.com).
2. Ve a la sección **API keys**, crea una clave nueva y recarga saldo ($2 es suficiente).
3. *(Opcional)* Si no agregas clave, el bot usará Workers AI de forma gratuita.

### 5) Descargar el proyecto e instalar dependencias

Clona el repositorio e instala los paquetes del proyecto:

```bash
git clone https://github.com/Mack-Yilman/notion-habit-coach.git
cd notion-habit-coach
npm install
```

### 6) Configurar variables de entorno y secretos

Copia el archivo de variables de ejemplo:

```bash
cp .dev.vars.example .dev.vars
```

Edita `.dev.vars` y completa las siguientes variables:

- `NOTION_TOKEN`: Token de tu integración interna de Notion.
- `TELEGRAM_BOT_TOKEN`: Token de tu bot de @BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: Texto largo y aleatorio para validar el webhook (solo letras, números, `_` y `-`). Puedes generarlo con `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
- `LLM_API_KEY`: Clave de API de DeepSeek (déjalo vacío si no usas DeepSeek).
- `ADMIN_SECRET`: Clave secreta para ejecutar acciones administrativas manuales.
- `TELEGRAM_CHAT_ID`: Se obtiene en el siguiente paso.

### 7) Conectar Notion y preparar propiedades

Verifica la conexión con Notion y detecta las fuentes de datos:

```bash
node scripts/setup.mjs notion
```

El script busca la base «Hábitos» y guarda su ID en `wrangler.jsonc` (`vars.HABITOS_DATA_SOURCE_ID`). Si encuentra varias, te muestra la lista para que pegues el correcto.

Luego, agrega las 4 columnas de racha a la base «Hábitos» (solo agrega columnas; no borra nada):

```bash
node scripts/setup.mjs notion --aplicar
```

### 8) Obtener tu Chat ID de Telegram

1. Ejecuta en tu terminal:

```bash
node scripts/setup.mjs chat-id
```

2. Mientras el script espera, abre tu bot en Telegram y envíale `/start`.
3. El script mostrará tu ID de chat. Cópialo y colócalo en `.dev.vars` como `TELEGRAM_CHAT_ID`.

### 9) Configurar Cloudflare y KV

Inicia sesión en Cloudflare:

```bash
npx wrangler login
```

Crea el namespace de KV para el estado efímero:

```bash
npx wrangler kv namespace create STATE
```

Pega el `id` obtenido en `wrangler.jsonc` dentro de `kv_namespaces`:

```jsonc
"kv_namespaces": [
  { "binding": "STATE", "id": "TU_ID_DE_KV" }
]
```

Revisa la variable `TZ` en `wrangler.jsonc` (por defecto `America/Lima`) y ajústala a tu zona horaria si es distinta.

### 10) Subir los secretos a Cloudflare

Sube todos los secretos del archivo `.dev.vars` a Cloudflare de una sola vez:

```bash
npx wrangler secret bulk .dev.vars
```

Este comando carga todos los secretos definidos en `.dev.vars` en tu Worker.

### 11) Desplegar el Worker

Despliega tu Worker en Cloudflare:

```bash
npx wrangler deploy
```

Al terminar, copia la URL generada: `https://notion-habit-coach.<tu-subdominio>.workers.dev`.

### 12) Registrar el webhook y comandos del bot

Registra la URL de tu Worker y los comandos en Telegram:

```bash
node scripts/setup.mjs webhook --url https://notion-habit-coach.<tu-subdominio>.workers.dev
```

### 13) Probar el bot

Escribe `/hoy` en Telegram. El bot responderá con el resumen del día y un mensaje con botones por cada hábito pendiente.

## Activar recurrencias y agregar hábitos

El bot no crea hábitos: lee las filas diarias que Notion genera con las **plantillas recurrentes** de la base «Hábitos». Cada hábito es una plantilla que se repite todos los días.

**Activar un hábito de la plantilla**

1. Abre la base **Hábitos** y pulsa la flecha **▾** junto a **Nuevo** para ver las plantillas.
2. En el hábito que quieras usar: **•••** → **Repetir** → **Diariamente** (o los días que elijas) y guarda.
3. Desde el día siguiente, a las 00:00, Notion crea su fila del día y el bot ya la incluye en los avisos.

**Agregar un hábito nuevo**

1. En el mismo menú de plantillas, en **New page** (la plantilla base): **•••** → **Duplicar**.
2. En la copia, cambia el nombre y completa **Identidad**, **Objetivo** y **Rango horario** (el rango decide en qué aviso aparece: mañana, tarde, noche o durante el día).
3. Llena la **Matriz Atómica** (la **Señal** aparece en los avisos con 💡) y el **Protocolo** (qué significa cada nivel). Déjalas dentro de un **bloque sincronizado**, como indica la plantilla base, para que tus cambios lleguen también a las filas ya creadas.
4. Actívale la repetición: **•••** → **Repetir** → **Diariamente**.
5. Opcional: enlaza su ficha de «Estadísticas» en la propiedad **Estadística**. Si no lo haces, el bot agrupa la racha por el nombre del hábito, así que no lo cambies después.

Tras editar Matrices, envía `/actualizar` al bot para que las vuelva a leer.

**¿Desde cuándo cuenta un hábito nuevo?** Desde su primera fila diaria (normalmente, al día siguiente de activar la repetición). No hay que tocar el bot: lo detecta solo, lo incluye en los avisos de su rango horario y su racha empieza en 0 con 🧊🧊. Si pausas la repetición de un hábito, los días sin fila son neutros: no suman ni gastan congeladores.

## Comandos del bot

| Comando | Descripción |
| --- | --- |
| `/hoy` | Resumen del día y un mensaje con botones por cada hábito pendiente. |
| `/pendientes` | Un mensaje con botones por cada hábito pendiente de hoy. |
| `/rachas` | Muestra el estado de tus rachas y congeladores disponibles. |
| `/resumen` | Solicita una intervención del coach de IA en el momento. |
| `/semana` | Revisión de los últimos 14 días con el coach, más un mapa en emojis: una fila por hábito, en dos semanas de 7 (➖ = ese día no tenía fila). |
| `/recalcular` | Rehace las rachas desde el historial de Notion (hasta unos 3 meses). Con muchos hábitos puede pedirte que lo envíes otra vez para terminar, por el límite del plan gratuito de Cloudflare. |
| `/actualizar` | Vuelve a leer y actualizar las Matrices Atómicas en caché. |
| `/ayuda` | Muestra la ayuda y lista de comandos disponibles. |

Cualquier otro mensaje va al coach de IA. El coach entiende lenguaje natural y puede marcar hábitos automáticamente (por ejemplo: «ya fui al gym»); la tarjeta de ese hábito se actualiza sola. El chat libre tiene un límite máximo de 30 mensajes por día (configurable con `CHAT_DAILY_LIMIT`).

## Personalizar

- **Horario de bloques (`SCHEDULE`)**: Configura la variable `SCHEDULE` en `wrangler.jsonc` con el formato `clave=HH:MM` separado por comas (por ejemplo: `manana=06:30,cierre=23:00,...`). Slots permitidos: `manana`, `manana_ultimo`, `tarde`, `tarde_ultimo`, `noche`, `noche_ultimo`, `cierre` y `procesar`.
- **Proveedor de IA**: Puedes cambiar a otro proveedor compatible con OpenAI (como OpenRouter) cambiando `LLM_BASE_URL` y `LLM_MODEL` en `wrangler.jsonc` y actualizando `LLM_API_KEY`.
- **Zona horaria (`TZ`)**: Ajusta la variable `TZ` en `wrangler.jsonc` para tu zona horaria (ejemplo: `Europe/Madrid`, `America/Mexico_City`).
- **Nuevos hábitos**: Agrega hábitos desde Notion mediante tu plantilla recurrente habitual; el bot los detecta de forma automática sin cambios en el código.

## Probar a mano

Las pruebas automáticas (tipos y Vitest) corren en GitHub Actions en cada push a `main` y en cada PR. En tu computadora: `npm test` y `npx tsc --noEmit`.

Puedes probar manualmente cualquier bloque horario enviando una petición con tu secreto administrativo:

```bash
curl -H "x-admin-secret: TU_SECRETO" "https://<URL>/admin/run?slot=manana"
```

Slots disponibles:

- `manana`
- `manana_ultimo`
- `tarde`
- `tarde_ultimo`
- `noche`
- `noche_ultimo`
- `cierre`
- `procesar`

## Solución de problemas

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| El bot no responde. | Webhook no registrado o `TELEGRAM_CHAT_ID` incorrecto. | Ejecuta `node scripts/setup.mjs webhook --url <URL>` y verifica que tu chat ID esté en `.dev.vars` y subido a Cloudflare. |
| Error «object_not_found» de Notion. | La página no está compartida con la integración. | Entra en tu página «Habit Tracker Pro» en Notion, ve a ••• → **Conexiones** y añade la integración. |
| No llegan los avisos programados. | No hay hábitos pendientes en ese bloque o el ID de KV `STATE` está mal configurado. | Verifica si hay tareas pendientes en ese bloque y revisa que el `id` en `kv_namespaces` de `wrangler.jsonc` sea el correcto. |
| La racha no se actualiza. | Faltan las columnas de racha en «Hábitos». | Ejecuta `node scripts/setup.mjs notion --aplicar` para agregarlas automáticamente. |
| «🩺 Notion no creó las filas de hoy». | Las plantillas de tus hábitos no tienen la repetición diaria activa. | Activa la recurrencia de cada plantilla (ver «Activar recurrencias y agregar hábitos»). |
| El coach responde con texto fijo. | Fallaron DeepSeek y Workers AI: cuenta de DeepSeek sin saldo, `LLM_API_KEY` mal configurada o una caída puntual de ambos. | Revisa tu saldo en DeepSeek y verifica que la clave esté cargada en Cloudflare con `npx wrangler secret bulk .dev.vars`. El aviso «🩺 Revisión del bot» trae el error de cada proveedor. |

## Privacidad y seguridad

- **Tus datos están aislados**: Toda la información reside en tu propia cuenta de Notion y en tu Cloudflare Worker.
- **Acceso restringido**: El bot solo responde a los mensajes que provienen de tu `TELEGRAM_CHAT_ID`.
- **Validación del webhook**: Las solicitudes de Telegram se validan mediante el secreto `TELEGRAM_WEBHOOK_SECRET`.
- **Cuidado de credenciales**: Nunca subas tu archivo `.dev.vars` ni tus secretos a GitHub.
- **Interacción con IA**: Lo que conversas en el chat libre y los resúmenes del coach se envía a DeepSeek para su procesamiento.

## Licencia y créditos

Habit Coach y la plantilla Habit Tracker Pro © 2026 Mack Chirinos. Desarrollado por Mack Chirinos con Claude Code.

Se permite el uso personal no comercial con cita; modificar, redistribuir o cualquier uso comercial requiere permiso previo y por escrito del autor. Para más detalles, consulta [LICENSE.md](LICENSE.md).

- **Cómo citar**: Usa el formato corto citando «Habit Coach — Mack Chirinos» con enlace al repositorio: [https://github.com/Mack-Yilman/notion-habit-coach](https://github.com/Mack-Yilman/notion-habit-coach).
- **Cómo pedir permiso**: Abre una incidencia (*issue*) en el repositorio oficial de GitHub.
