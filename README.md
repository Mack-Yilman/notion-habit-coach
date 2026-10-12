# Habit Coach para Notion

Bot de Telegram con coach de IA que hace accionable tu plantilla Habit Tracker Pro de Notion.

## Qué hace

- **Avisos por bloque horario**: Notificaciones según tu momento del día (no por hora fija), con la lista de hábitos pendientes y la «Señal» de la Matriz Atómica asociada a cada uno.
- **Registro rápido con botones**: Botones interactivos para marcar el estado directamente en Notion:
  - ⚡ **Hecho**
  - 🕯️ **Parcial**
  - 🔥 **Superado**
  - 🚀 **Alto impacto**
  - 💤 **Omitido**
- **Rachas inteligentes**: Sistema de rachas con 2 congeladores por hábito para proteger tu constancia ante imprevistos.
- **Coach de IA**: Cierre diario nocturno, revisión semanal los domingos y modo de chat libre que comprende lenguaje natural y puede registrar hábitos automáticamente (por ejemplo: «ya fui al gym»).

## Cómo funciona

Notion es la **única base de datos** del sistema. El Cloudflare Worker no almacena datos de tus hábitos; solo guarda estado efímero en KV (deduplicación de avisos, memoria corta del chat y caché de la Matriz Atómica).

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

| Bloque / Slot | Hora local | Descripción |
| --- | --- | --- |
| `manana` | 06:30 | Mañana: incluye madrugada/Dormir, mañana y «durante el día». |
| `manana_ultimo` | 10:30 | Último llamado de la mañana (pendientes de madrugada y mañana). |
| `tarde` | 12:30 | Bloque de la tarde. |
| `tarde_ultimo` | 16:30 | Último llamado de la tarde. |
| `noche` | 18:30 | Bloque de la noche. |
| `noche_ultimo` | 21:30 | Último llamado del día (noche + durante el día). |
| `cierre` | 23:00 | Cierre con coach (los domingos incluye la revisión semanal). |
| `procesar` | 03:00 | Procesa las rachas del día anterior (lo marcado de madrugada aún cuenta). |

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
- **Respaldo gratuito**: Sin clave de DeepSeek o ante fallos, usa Cloudflare Workers AI gratis (modelo Gemma). Si este falla, envía un resumen fijo predeterminado sin IA.

## Requisitos

- Cuenta de Notion.
- Cuenta de Telegram.
- Cuenta de Cloudflare (gratis).
- Node.js 20+.
- Git.

## Instalación paso a paso

### 1) Duplicar la plantilla de Notion
Duplica la plantilla «Habit Tracker Pro» de Mack Chirinos en tu cuenta de Notion (el enlace público se publicará pronto en este repositorio; mientras tanto, pídelo abriendo un *issue*).

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
Escribe `/hoy` en Telegram. El bot responderá con los hábitos de hoy y sus botones para marcar estado.

## Comandos del bot

| Comando | Descripción |
| --- | --- |
| `/hoy` | Muestra todos los hábitos de hoy con botones interactivos. |
| `/pendientes` | Lista únicamente los hábitos pendientes de hoy. |
| `/rachas` | Muestra el estado de tus rachas y congeladores disponibles. |
| `/resumen` | Solicita una intervención del coach de IA en el momento. |
| `/semana` | Ejecuta la revisión semanal con el coach ahora mismo. |
| `/recalcular` | Rehace las rachas completas desde el historial de Notion. |
| `/actualizar` | Vuelve a leer y actualizar las Matrices Atómicas en caché. |
| `/ayuda` | Muestra la ayuda y lista de comandos disponibles. |

Cualquier otro mensaje va al coach de IA. El coach entiende lenguaje natural y puede marcar hábitos automáticamente (por ejemplo: «ya fui al gym»). El chat libre tiene un límite máximo de 30 mensajes por día (configurable con `CHAT_DAILY_LIMIT`).

## Personalizar

- **Horario de bloques (`SCHEDULE`)**: Configura la variable `SCHEDULE` en `wrangler.jsonc` con el formato `clave=HH:MM` separado por comas (por ejemplo: `manana=06:30,cierre=23:00,...`). Slots permitidos: `manana`, `manana_ultimo`, `tarde`, `tarde_ultimo`, `noche`, `noche_ultimo`, `cierre` y `procesar`.
- **Proveedor de IA**: Puedes cambiar a otro proveedor compatible con OpenAI (como OpenRouter) cambiando `LLM_BASE_URL` y `LLM_MODEL` en `wrangler.jsonc` y actualizando `LLM_API_KEY`.
- **Zona horaria (`TZ`)**: Ajusta la variable `TZ` en `wrangler.jsonc` para tu zona horaria (ejemplo: `Europe/Madrid`, `America/Mexico_City`).
- **Nuevos hábitos**: Agrega hábitos desde Notion mediante tu plantilla recurrente habitual; el bot los detecta de forma automática sin cambios en el código.

## Probar a mano

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
| El coach responde con texto fijo. | Cuenta de DeepSeek sin saldo o `LLM_API_KEY` mal configurada. | Revisa tu saldo en DeepSeek y verifica que la clave esté cargada en Cloudflare con `npx wrangler secret bulk .dev.vars`. |

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
