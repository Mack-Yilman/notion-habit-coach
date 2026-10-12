import { describe, expect, it } from 'vitest';
import { keyboardFor, renderLista, renderRachas } from '../src/messages';
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

describe('renderLista', () => {
  it('muestra la señal de la Matriz en los pendientes y escapa HTML', () => {
    const r = renderLista('<b>Tarde</b>', [entry({ nombre: 'A <b> & B' })], { h1: 'Al despertar de la siesta' });
    expect(r.text).toContain('A &lt;b&gt; &amp; B');
    expect(r.text).toContain('💡 <i>Al despertar de la siesta</i>');
  });
  it('muestra la racha del hábito pendiente', () => {
    const r = renderLista('X', [entry({ streak: { racha: 5, mejor: 5, congeladores: 2, cerrada: false } })]);
    expect(r.text).toContain('· 🔥5');
  });
  it('tacha lo ya registrado y celebra cuando no queda nada', () => {
    const r = renderLista('X', [entry({ estado: 'hecho' })]);
    expect(r.text).toContain('<s>Ir al gimnasio</s>');
    expect(r.text).toContain('¡Todo registrado');
  });
});

describe('keyboardFor', () => {
  it('una fila de 5 botones por hábito; el primero lleva el nombre', () => {
    const kb = keyboardFor([entry()]);
    expect(kb).toHaveLength(1);
    expect(kb[0]).toHaveLength(5);
    expect(kb[0]![0]!.text).toBe('⚡ Ir al gimnasio');
    expect(kb[0]![0]!.callback_data).toBe('e:3f727351c36780aabbbb0123456789ab:h');
  });
  it('marca con ✅ el estado actual', () => {
    const kb = keyboardFor([entry({ estado: 'parcial' })]);
    expect(kb[0]![1]!.text).toBe('✅');
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
