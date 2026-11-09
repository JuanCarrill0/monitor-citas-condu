# Monitor de horarios de citas

Avisa por Telegram cuando se abren horarios nuevos en una página de reserva de
citas.

Esas páginas suelen servir un HTML que es solo un shell de JavaScript, así que
el monitor la renderiza con Playwright (Chromium headless), recorre el
calendario mes a mes, abre cada día que tenga cupo y lee los horarios del DOM.

**Solo lee.** No reserva nada, no resuelve captchas y no usa endpoints internos
de la página.

> La dirección a monitorear no está en el código. Es un enlace con capacidad de
> reservar, así que se pasa por `SCHEDULE_URL` (un `.env` local o un secret de
> GitHub) y nunca se commitea.

## Cómo decide qué avisar

1. Recorre el mes actual y los `MONTHS_AHEAD` siguientes (por defecto 2).
2. En cada mes identifica los días con cupo por el `aria-label` de su botón.
   Los días de meses vecinos que aparecen en la grilla se ignoran ahí y se
   revisan al navegar a su mes.
3. Hace clic en cada día con cupo y recoge todos los horarios visibles (el
   panel muestra varios días a la vez, así que se deduplica).
4. Descarta horarios ya pasados y los que caigan en `EXCLUDE_DATES`.
5. Compara contra `state.json` y avisa **solo los nuevos**.

`state.json` guarda la foto completa de lo disponible, no un acumulado: si un
horario desaparece y más tarde se libera otra vez, vuelve a contar como nuevo.
El archivo solo se reescribe cuando la lista cambia de verdad.

En la **primera** ejecución no envía nada: guarda la línea base para no
mandarte de golpe todo lo que ya existe.

## Uso local

```bash
npm install
npx playwright install chromium
cp .env.example .env     # y pon la URL, tu token y tu chat id

node monitor.js            # una revisión y sale
node monitor.js --loop 10  # revisa cada 10 minutos
node monitor.js --test     # mensaje de prueba a Telegram
node monitor.js --dry-run  # revisa e imprime el mensaje, sin enviarlo ni tocar el estado
```

En `--loop`, si falla 3 veces seguidas te avisa por Telegram y sigue
intentando. En modo de una sola revisión, si la página no carga o no aparece el
calendario, sale con **exit code 1** en vez de quedarse callado.

Con `DEBUG=1` se imprime el stack completo de los errores.

## Configuración

Se lee de variables de entorno o de un `.env` opcional en el directorio actual.

| Variable | Obligatoria | Por defecto | Qué hace |
|---|---|---|---|
| `SCHEDULE_URL` | sí | — | Página a monitorear |
| `TELEGRAM_BOT_TOKEN` | sí | — | Token de @BotFather |
| `TELEGRAM_CHAT_ID` | sí | — | A quién enviar |
| `MONTHS_AHEAD` | no | `2` | Meses a revisar además del actual |
| `EXCLUDE_DATES` | no | vacío | Fechas a ignorar, `YYYY-MM-DD` con comas |
| `SCHEDULE_TITLE` | no | `Agenda de citas` | Título del mensaje |
| `STATE_FILE` | no | `state.json` junto al script | Ruta del estado |

La zona horaria usada para interpretar y mostrar los horarios está fijada en
[`monitor.js`](monitor.js) (constante `TZ`).

## Despliegue en GitHub Actions

El workflow [`.github/workflows/monitor.yml`](.github/workflows/monitor.yml)
corre cada 10 minutos y commitea `state.json` de vuelta al repo para recordar
qué horarios ya avisó.

1. Crea el repo en GitHub (**público**: en repos privados cada corrida consume
   de los 2000 min/mes gratis y a esta frecuencia se agotarían en una semana).
2. Push.
3. En **Settings → Secrets and variables → Actions**, pestaña *Secrets*:
   - `SCHEDULE_URL`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `SCHEDULE_TITLE` (opcional)
4. Opcional, en la pestaña *Variables*: `MONTHS_AHEAD`, `EXCLUDE_DATES`.
   Van como variables y no como secrets porque son visibles sin riesgo.
5. En **Actions**, ejecuta el workflow a mano con modo `test` para confirmar
   que Telegram responde.

### Cosas que conviene saber

- **El cron no es exacto.** GitHub retrasa los *scheduled workflows* entre 5 y
  20 minutos en horas pico, y puede saltarse corridas si el repo lleva tiempo
  sin actividad. `*/10` es un piso, no una garantía.
- **Los crons se desactivan solos** en repos sin commits durante 60 días. Como
  el workflow commitea `state.json` cuando cambia la disponibilidad, basta con
  que la agenda se mueva de vez en cuando; si no, entra y ejecútalo a mano.
- **Los secrets no se exponen** en los logs: Telegram se llama desde Node,
  nunca por la línea de comandos, y GitHub enmascara los valores.
- **Si la página cambia su HTML**, el monitor falla ruidosamente (exit 1) y la
  corrida aparece en rojo en la pestaña Actions. Lo que habría que revisar
  entonces son los selectores del calendario, agrupados y comentados en
  [`monitor.js`](monitor.js). Las clases CSS de la página están ofuscadas, así
  que a propósito no se usan como selectores.
