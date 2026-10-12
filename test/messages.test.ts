import { describe, expect, it } from 'vitest';
import { headerAviso, renderCard, renderRachas, renderResumenHoy } from '../src/messages';
import { parseMatrix } from '../src/matrix';
import { sanitizeLlmHtml } from '../src/telegram';
import type { Entry } from '../src/habits';

const entry = (over: Partial<Entry> = {}): Entry => ({
  pageId: '3f727351-c367-80aa-bbbb-0123456789ab',
  nombre: 'Ir al gimnasio',
  estado: 'sin_iniciar',
  fecha: '2026-10-12',
  rango: 'tarde',
  objetivo: '1 hora',
  identidad: '',
  habitId: 'h1',
  ...over,
});

describe('renderCard (un mensaje por hábito)', () => {
  it('pendiente: nombre, objetivo, racha y señal; escapa HTML', () => {
    const r = renderCard(entry({ nombre: 'A <b> & B', streak: { racha: 5, mejor: 5, congeladores: 2, cerrada: false } }), 'Al despertar de la siesta');
    expect(r.text).toBe('<b>A &lt;b&gt; &amp; B</b> · 1 hora · 🔥5\n💡 <i>Al despertar de la siesta</i>');
  });
  it('pendiente: solo los 5 íconos en el orden del Protocolo, sin ⚪ ni ✅ ni números', () => {
    const kb = renderCard(entry()).keyboard;
    expect(kb).toHaveLength(1);
    expect(kb[0]!.map((b) => b.text)).toEqual(['💤', '🕯️', '⚡', '🔥', '🚀']);
    expect(kb[0]![2]!.callback_data).toBe('e:3f727351c36780aabbbb0123456789ab:h');
  });
  it('registrado: muestra el nivel y un único botón ↩️ para deshacer', () => {
    const r = renderCard(entry({ estado: 'hecho' }));
    expect(r.text).toBe('⚡ <b>Ir al gimnasio</b> · <i>Hecho</i>');
    expect(r.keyboard).toEqual([[{ text: '↩️', callback_data: 'u:3f727351c36780aabbbb0123456789ab' }]]);
  });
  it('conserva la cabecera del aviso al editar', () => {
    const header = headerAviso('<b>🌆 Tarde</b>', 'Lo que toca:');
    expect(header).toContain('💤 Omitido · 🕯️ Parcial · ⚡ Hecho · 🔥 Superado · 🚀 Alto impacto');
    expect(renderCard(entry({ estado: 'parcial' }), undefined, header).text.startsWith(header)).toBe(true);
  });
});

describe('renderResumenHoy', () => {
  it('agrupa por rango, muestra estados y cuenta pendientes', () => {
    const t = renderResumenHoy('<b>Hoy</b>', [entry({ nombre: 'B', rango: 'noche' }), entry({ nombre: 'A', rango: 'manana', estado: 'hecho' })]);
    expect(t).toContain('1/2 registrados');
    expect(t).toMatch(/Mañana[\s\S]*⚡ A[\s\S]*Noche[\s\S]*⚪ B/);
    expect(t).toContain('los 1 pendientes');
  });
});

describe('renderRachas', () => {
  it('ordena por racha y muestra congeladores', () => {
    const t = renderRachas([
      { habitId: 'a', nombre: 'A', state: { racha: 2, mejor: 2, congeladores: 1, procesadoHasta: '2026-10-12' } },
      { habitId: 'b', nombre: 'B', state: { racha: 9, mejor: 9, congeladores: 2, procesadoHasta: '2026-10-12' } },
    ]);
    expect(t.indexOf('B')).toBeLessThan(t.indexOf('A'));
    expect(t).toContain('🧊🧊');
  });
});

describe('parseMatrix', () => {
  it('extrae la Matriz Atómica y el Protocolo', () => {
    const m = parseMatrix([
      {
        heading: 'Matriz Atómica',
        rows: [
          ['Señal 💡 [Hacerlo Obvio]', 'A las 4:30 PM, al sonar la alarma'],
          ['Anhelo ✨ [Hacerlo Atractivo]', 'Canción de Hunter x Hunter'],
          ['Respuesta 💪🏻[Hacerlo Sencillo]', 'Ropa lista después de almorzar'],
          ['Recompensa 🏆[Hacerlo Satisfactorio]', ''],
        ],
      },
      {
        heading: 'Protocolo de Ejecución Flexible',
        rows: [
          ['Estado', 'Nivel', 'Especificación del objetivo'],
          ['⚪ Sin iniciar', '0', 'No iniciar el hábito'],
          ['🕯️ Parcial', '2', '20 minutos de cardio'],
        ],
      },
    ]);
    expect(m.senal).toBe('A las 4:30 PM, al sonar la alarma');
    expect(m.respuesta).toBe('Ropa lista después de almorzar');
    expect(m.recompensa).toBeUndefined();
    expect(m.protocolo.parcial).toBe('20 minutos de cardio');
    expect(m.protocolo.sin_iniciar).toBe('No iniciar el hábito');
  });
});

describe('sanitizeLlmHtml', () => {
  it('convierte Markdown y escapa etiquetas no permitidas', () => {
    expect(sanitizeLlmHtml('**Bien** <script>x</script> & <i>ok</i>')).toBe(
      '<b>Bien</b> &lt;script&gt;x&lt;/script&gt; &amp; <i>ok</i>',
    );
  });
  it('cierra etiquetas abiertas y quita cierres huérfanos', () => {
    expect(sanitizeLlmHtml('<b>hola')).toBe('<b>hola</b>');
    expect(sanitizeLlmHtml('hola</i>')).toBe('hola');
  });
  it('elimina bloques de razonamiento', () => {
    expect(sanitizeLlmHtml('<think>pienso</think>Respuesta')).toBe('Respuesta');
  });
});
