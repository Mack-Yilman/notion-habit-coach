import { describe, expect, it } from 'vitest';
import { ajusteParaGuardar, extraerAjuste, fichaPeriodo, lineaAjusteAnterior, renderCifras, renderCifrasDia, renderMapaMes, resumir, semanaYPrevia } from '../src/periodo';
import { esUltimoDiaDelMes, inicioMes, mesAnterior, nombreMes } from '../src/time';
import type { Entry, Stats } from '../src/habits';

const e = (nombre: string, fecha: string, estado: Entry['estado'], rango: Entry['rango'] = 'manana'): Entry => ({
  pageId: `${nombre}-${fecha}`,
  habitId: `h-${nombre}`,
  nombre,
  fecha,
  estado,
  rango,
  objetivo: '',
  identidad: '',
});

/** Un hábito con `ok` de `tot` días cumplidos a partir de `desde`. */
const serie = (nombre: string, desde: string, ok: number, tot: number, rango: Entry['rango'] = 'manana') =>
  Array.from({ length: tot }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, Number(desde.slice(8)) + i, 12)).toISOString().slice(0, 10);
    return e(nombre, d, i < ok ? 'hecho' : 'sin_iniciar', rango);
  });

describe('fechas del mes', () => {
  it('esUltimoDiaDelMes', () => {
    expect(esUltimoDiaDelMes('2026-10-31')).toBe(true);
    expect(esUltimoDiaDelMes('2026-10-30')).toBe(false);
    expect(esUltimoDiaDelMes('2026-02-28')).toBe(true);
    expect(esUltimoDiaDelMes('2028-02-28')).toBe(false); // bisiesto
    expect(esUltimoDiaDelMes('2028-02-29')).toBe(true);
    expect(esUltimoDiaDelMes('2026-04-30')).toBe(true);
  });
  it('inicio, mes anterior y nombre', () => {
    expect(inicioMes('2026-10-26')).toBe('2026-10-01');
    expect(mesAnterior('2026-01-15')).toBe('2025-12');
    expect(mesAnterior('2026-10-26')).toBe('2026-09');
    expect(nombreMes('2026-10-26')).toBe('octubre 2026');
  });
});

describe('resumir y cifras', () => {
  it('cuenta Parcial o mejor como cumplido y solo dentro del rango de fechas', () => {
    const r = resumir([e('Gym', '2026-10-01', 'parcial'), e('Gym', '2026-10-02', 'omitido'), e('Gym', '2026-09-30', 'hecho')], '2026-10-01', '2026-10-31');
    expect(r.total).toEqual({ ok: 1, tot: 2, fuerte: 0 });
  });

  it('semana contra semana anterior: cumplimiento, mejor y peor hábito, y cambios', () => {
    const hist = [
      ...serie('Dormir', '2026-10-12', 7, 7), // previa 100 %
      ...serie('Dormir', '2026-10-19', 7, 7), // actual 100 %
      ...serie('Gym', '2026-10-12', 6, 7), // previa 86 %
      ...serie('Gym', '2026-10-19', 2, 7), // actual 29 %
    ];
    const { actual, previo } = semanaYPrevia(hist, '2026-10-25');
    expect(actual.desde).toBe('2026-10-19');
    expect(previo.desde).toBe('2026-10-12');
    const c = renderCifras(actual, previo, 'los 7 días anteriores');
    expect(c).toContain('Cumplimiento: <b>64 %</b> (9/14)');
    expect(c).toContain('🔽 -29 pts vs. los 7 días anteriores (93 %)');
    expect(c).toContain('💪 Más constante: Dormir 100 %');
    expect(c).toContain('🌧️ Más flojo: Gym 29 %');
    expect(c).toContain('⚠️ Más cayó: Gym 🔽 -57 pts');
  });

  it('sin periodo anterior no compara; sin filas no devuelve nada', () => {
    const r = resumir(serie('Gym', '2026-10-01', 3, 5), '2026-10-01', '2026-10-31');
    const c = renderCifras(r, null, 'el mes anterior');
    expect(c).toContain('Cumplimiento: <b>60 %</b> (3/5)');
    expect(c).not.toContain('vs.');
    expect(renderCifras(resumir([], '2026-10-01', '2026-10-31'), null, 'x')).toBe('');
  });

  it('un hábito con menos de 3 filas no entra en mejor/peor', () => {
    const r = resumir([...serie('Gym', '2026-10-01', 5, 5), e('Nuevo', '2026-10-05', 'sin_iniciar')], '2026-10-01', '2026-10-31');
    expect(renderCifras(r, null, 'x')).not.toContain('Nuevo');
  });
});

describe('renderMapaMes', () => {
  it('nombre en su línea y un cuadro por semana', () => {
    const hist = [...serie('Gym', '2026-10-01', 7, 7), ...serie('Gym', '2026-10-08', 2, 7), ...serie('Gym', '2026-10-15', 5, 5)];
    const m = renderMapaMes(hist, '2026-10-01', '2026-10-19');
    expect(m).toContain('<b>Gym</b> · 74 %\n🟩🟥🟩'); // 14/19
    expect(m).toContain('Semanas:');
    expect(renderMapaMes([], '2026-10-01', '2026-10-19')).toBe('');
  });
});

describe('fichaPeriodo', () => {
  const stats = { 'h-Gym': { habitId: 'h-Gym', nombre: 'Gym', state: { racha: 4, mejor: 9, congeladores: 1, procesadoHasta: '2026-10-31' } } } as any;
  const matrices = { 'h-Gym': { senal: 'Ropa lista', protocolo: { parcial: '10 sentadillas' } }, 'h-Dormir': { protocolo: {} } } as any;

  it('trae tasa, cambio, omitidos, racha, Señal y versión mínima de los más flojos', () => {
    const hist = [...serie('Gym', '2026-10-01', 2, 7), ...serie('Dormir', '2026-10-01', 7, 7), e('Gym', '2026-10-08', 'omitido')];
    const actual = resumir(hist, '2026-10-01', '2026-10-31');
    const previo = { ...actual, porHabito: { Gym: { ok: 6, tot: 7 }, Dormir: { ok: 7, tot: 7 } } };
    const f = fichaPeriodo(hist, actual, previo, stats, matrices);
    expect(f).toContain('FICHA POR HÁBITO DEL PERIODO (2026-10-01 a 2026-10-31');
    expect(f).toMatch(/- Gym \| Mañana[^|]*\| 25 % \(2\/8\) \| vs\. periodo anterior 🔽 -61 pts \| 1 omitidos \| por semana 29 % → 0 % \| racha al cierre del periodo 4 \(mejor 9\), 1 🧊 \| Señal: Ropa lista \| versión mínima: 10 sentadillas/);
    expect(f).toMatch(/- Dormir \|[^\n]*sin Señal definida/);
  });

  it('el mejor y el peor día de la semana solo con 3 o más filas por día', () => {
    const dias = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']; // lunes
    const jue = ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22']; // jueves
    const hist = [...dias.map((d) => e('Gym', d, 'sin_iniciar')), ...jue.map((d) => e('Gym', d, 'hecho'))];
    const f = fichaPeriodo(hist, resumir(hist, '2026-10-01', '2026-10-31'), null, {}, {});
    expect(f).toContain('mejor día jueves 100 %, peor lunes 0 %');
    const pocos = fichaPeriodo(hist.slice(0, 2), resumir(hist.slice(0, 2), '2026-10-01', '2026-10-31'), null, {}, {});
    expect(pocos).not.toContain('mejor día');
  });

  it('sin filas no devuelve nada y no menciona hoy ni ayer', () => {
    expect(fichaPeriodo([], resumir([], '2026-10-01', '2026-10-31'), null, {}, {})).toBe('');
    const f = fichaPeriodo(serie('Gym', '2026-10-01', 3, 5), resumir(serie('Gym', '2026-10-01', 3, 5), '2026-10-01', '2026-10-31'), null, {}, {});
    expect(f).not.toMatch(/hoy|ayer/i);
  });
});

describe('renderCifras calidad y parciales', () => {
  it('calidad con y sin fuerte en el periodo anterior', () => {
    const actual = {
      desde: '2026-10-19',
      hasta: '2026-10-25',
      total: { ok: 8, tot: 10, fuerte: 6 },
      porHabito: {
        Gym: { ok: 4, tot: 5, fuerte: 2 },
        Dormir: { ok: 4, tot: 5, fuerte: 4 },
      },
      porRango: {},
    };

    const cSinPrevio = renderCifras(actual, null, 'semana anterior');
    expect(cSinPrevio).toContain('⚡ Calidad: <b>60 %</b> en Hecho o mejor');
    expect(cSinPrevio).not.toContain('pts');
    expect(cSinPrevio).toContain('🕯️ Más en Parcial: Gym 2/5');

    const previoSinFuerte = {
      desde: '2026-10-12',
      hasta: '2026-10-18',
      total: { ok: 5, tot: 10 },
      porHabito: {},
      porRango: {},
    };
    const cPrevioSinFuerte = renderCifras(actual, previoSinFuerte, 'semana anterior');
    expect(cPrevioSinFuerte).toContain('⚡ Calidad: <b>60 %</b> en Hecho o mejor');
    const lineaCalidad = cPrevioSinFuerte.split('\n').find((l) => l.includes('Calidad'));
    expect(lineaCalidad).toBe('⚡ Calidad: <b>60 %</b> en Hecho o mejor');

    const previoConFuerte = {
      desde: '2026-10-12',
      hasta: '2026-10-18',
      total: { ok: 5, tot: 10, fuerte: 4 },
      porHabito: {},
      porRango: {},
    };
    const cPrevioConFuerte = renderCifras(actual, previoConFuerte, 'semana anterior');
    expect(cPrevioConFuerte).toContain('⚡ Calidad: <b>60 %</b> en Hecho o mejor · 🔼 +20 pts');
  });
});

describe('renderCifrasDia', () => {
  it('el caso del formato completo y con líneas omitidas', () => {
    const entries = [
      e('Gym', '2026-10-12', 'hecho'),
      e('Dormir', '2026-10-12', 'hecho'),
      e('Agua', '2026-10-12', 'hecho'),
      e('Comer', '2026-10-12', 'hecho'),
      e('Pasear', '2026-10-12', 'hecho'),
      e('Escribir', '2026-10-12', 'hecho'),
      e('Leer', '2026-10-12', 'parcial'),
      e('Estudiar', '2026-10-12', 'parcial'),
      e('Meditar', '2026-10-12', 'sin_iniciar'),
    ];
    entries[0]!.habitId = 'h-sube';
    entries[8]!.habitId = 'h-gasta';
    const entriesExtra = [
      ...entries,
      { ...e('Correr', '2026-10-12', 'sin_iniciar'), habitId: 'h-pierde' },
    ];
    const sMap: Record<string, Stats> = {
      'h-sube': { habitId: 'h-sube', nombre: 'Gym', state: { racha: 1, mejor: 1, congeladores: 2, procesadoHasta: null } },
      'h-gasta': { habitId: 'h-gasta', nombre: 'Meditar', state: { racha: 5, mejor: 5, congeladores: 1, procesadoHasta: null } },
      'h-pierde': { habitId: 'h-pierde', nombre: 'Correr', state: { racha: 4, mejor: 4, congeladores: 0, procesadoHasta: null } },
    };

    const c = renderCifrasDia(entriesExtra, sMap);
    expect(c).toBe(
      '<b>📈 Hoy</b>\n' +
      'Cumplidos: <b>8/10</b> · 🕯️ 2 en Parcial · ⚡ 6 en Hecho o mejor\n' +
      '🔥 Rachas que suben: 1\n' +
      '🧊 Se gastarían: 1\n' +
      '💔 Rachas que se perderían: 1'
    );

    const entriesOmitidas = [
      { ...e('Gym', '2026-10-12', 'hecho'), habitId: 'h-sube' },
    ];
    const cOmit = renderCifrasDia(entriesOmitidas, sMap);
    expect(cOmit).toBe(
      '<b>📈 Hoy</b>\n' +
      'Cumplidos: <b>1/1</b> · ⚡ 1 en Hecho o mejor\n' +
      '🔥 Rachas que suben: 1'
    );

    expect(renderCifrasDia([], {})).toBe('');
  });
});

describe('extraerAjuste', () => {
  const nombres = ['Ir al gimnasio', 'Gimnasio', 'Leer 20 páginas', 'Meditar'];

  it('con hábito, sin hábito, sin etiqueta, con <b> dentro de la frase', () => {
    const htmlConHabito = `
<b>🏆 Logro</b>
Semana excelente.

<b>🔧 Ajuste:</b> Bajar el objetivo de Ir al gimnasio a 15 minutos.

<b>🎯 Foco</b>
Descansar el domingo.`;
    const resCon = extraerAjuste(htmlConHabito, nombres);
    expect(resCon).toEqual({
      texto: 'Bajar el objetivo de Ir al gimnasio a 15 minutos.',
      habito: 'Ir al gimnasio',
    });

    const htmlSinHabito = `
<b>🔧 Ajuste</b>
Cambiar la alarma general para levantarse 10 minutos antes.

<b>🎯 Foco</b>
Mantener el ritmo.`;
    const resSin = extraerAjuste(htmlSinHabito, nombres);
    expect(resSin).toEqual({
      texto: 'Cambiar la alarma general para levantarse 10 minutos antes.',
      habito: null,
    });

    const htmlSinEtiqueta = `
<b>🏆 Logro</b>
Todo cumplido.`;
    expect(extraerAjuste(htmlSinEtiqueta, nombres)).toBeNull();

    const htmlConTagInterno = `
<b>🔧 Ajuste</b>
Ajustar la señal de <b>Meditar</b> justo antes de dormir.
Esta segunda línea forma parte del ajuste.

<b>🎯 Foco</b>
Seguir así.`;
    const resInterno = extraerAjuste(htmlConTagInterno, nombres);
    expect(resInterno).toEqual({
      texto: 'Ajustar la señal de Meditar justo antes de dormir.\nEsta segunda línea forma parte del ajuste.',
      habito: 'Meditar',
    });
  });
});

describe('ajuste anterior', () => {
  const actual = { desde: '2026-10-19', hasta: '2026-10-25', total: { ok: 5, tot: 7 }, porHabito: { Gym: { ok: 5, tot: 7 } }, porRango: {} };

  it('una frase que empieza con el hábito en negrita no corta el bloque', () => {
    expect(extraerAjuste('<b>🔧 Ajuste</b>\n<b>Gym</b> pasa a la mañana.\n\n<b>🎯 Foco</b>\nSeguir.', ['Gym'])).toEqual({ texto: 'Gym pasa a la mañana.', habito: 'Gym' });
  });
  it('no compara la calidad contra un periodo vacío', () => {
    const vacio = { desde: 'a', hasta: 'b', total: { ok: 0, tot: 0, fuerte: 0 }, porHabito: {}, porRango: {} };
    expect(renderCifras({ ...actual, total: { ok: 5, tot: 7, fuerte: 4 } }, vacio, 'x')).not.toContain('pts');
  });
  it('acepta el emoji fuera de la negrita', () => {
    expect(extraerAjuste('🔧 <b>Ajuste</b>\nMover Gym.\n\n🎯 <b>Foco</b>\nSeguir.', ['Gym'])).toEqual({ texto: 'Mover Gym.', habito: 'Gym' });
  });
  it('guarda la tasa del hábito y la compara después', () => {
    const g = ajusteParaGuardar({ texto: 'Mover Gym', habito: 'Gym' }, '2026-10-18', { ...actual, porHabito: { Gym: { ok: 3, tot: 6 } } });
    expect(g.tasaAntes).toBe(50);
    expect(lineaAjusteAnterior(g, actual)).toContain('Gym pasó de 50 % a 71 %');
  });
  it('sin hábito identificado va sin cifra', () => {
    const g = ajusteParaGuardar({ texto: 'Dormir antes', habito: null }, '2026-10-18', actual);
    expect(g.tasaAntes).toBeNull();
    expect(lineaAjusteAnterior(g, actual)).toContain('Sin cifra disponible');
  });
});
