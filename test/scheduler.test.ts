import { describe, expect, it } from 'vitest';
import { closeDays, recalcular, revisarSalud, runScheduled } from '../src/scheduler';
import { matricesFor, tarjetasABorrar } from '../src/app';
import { TIMEOUT_CRON_MS } from '../src/coach';
import { cerrada, fakeApp, num, row } from './fakes';

/* eslint-disable @typescript-eslint/no-explicit-any */

// 2026-10-14 03:05 en Lima = 08:05 UTC
const NOW = '2026-10-14T08:05:00Z';

describe('closeDays', () => {
  const base = () => [
    row('g12', 'h-gym', 'Gym', '2026-10-12', '⚡ Hecho'),
    row('g13', 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar'),
    row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    row('a12', 'h-agua', 'Agua', '2026-10-12', '🕯️ Parcial', { r: 1, c: 2, cerrada: true }),
    row('a13', 'h-agua', 'Agua', '2026-10-13', '⚡ Hecho'),
  ];

  it('cierra cada día en su fila, sella hoy y deja notas', async () => {
    const { app, rows, kv } = fakeApp(NOW, base());
    const r = await closeDays(app);
    expect(r).toMatchObject({ hasta: '2026-10-13', incompleto: false, actualizados: 2 });
    const get = (id: string) => rows.find((x) => x.id === id);
    // Gym: 12 suma (1), 13 gasta congelador (1, 🧊1); hoy queda sellado sin cerrar
    expect([num(get('g12'), 'Racha'), cerrada(get('g12'))]).toEqual([1, true]);
    expect([num(get('g13'), 'Racha'), num(get('g13'), 'Congeladores'), cerrada(get('g13'))]).toEqual([1, 1, true]);
    expect([num(get('g14'), 'Racha'), num(get('g14'), 'Congeladores'), cerrada(get('g14'))]).toEqual([1, 1, false]);
    // Agua: ya tenía el 12 cerrado con racha 1 → el 13 suma
    expect(num(get('a13'), 'Racha')).toBe(2);
    expect(kv.m.get('notas:2026-10-14')).toContain('«Gym» usó un congelador');
  });

  it('es idempotente: una segunda ejecución no escribe nada', async () => {
    const { app, updates } = fakeApp(NOW, base());
    await closeDays(app);
    const n = updates.length;
    await closeDays(app);
    expect(updates).toHaveLength(n);
  });

  it('antes de las 03:00 no cierra ayer', async () => {
    const { app } = fakeApp('2026-10-14T07:30:00Z', base());
    expect((await closeDays(app)).hasta).toBe('2026-10-12');
  });

  it('se reanuda si se corta por el tope de escrituras', async () => {
    // 3 hábitos × 14 días = 42 escrituras > 36 → la primera pasada queda incompleta.
    const rows: any[] = [];
    for (const h of ['a', 'b', 'c']) for (let d = 1; d <= 14; d++) rows.push(row(`${h}${d}`, `h-${h}`, h, `2026-10-${String(d).padStart(2, '0')}`, '⚡ Hecho'));
    // 2026-10-15 03:05 Lima
    const { app } = fakeApp('2026-10-15T08:05:00Z', rows);
    expect((await closeDays(app)).incompleto).toBe(true);
    expect((await closeDays(app)).incompleto).toBe(false);
    const ultimo = (h: string) => rows.find((x) => x.id === `${h}14`);
    for (const h of ['a', 'b', 'c']) expect([num(ultimo(h), 'Racha'), cerrada(ultimo(h))]).toEqual([14, true]);
  });

  it('sin filas cerradas en la ventana busca la última cerrada antes', async () => {
    const rows: any[] = [row('old', 'h-gym', 'Gym', '2026-09-20', '⚡ Hecho', { r: 30, c: 2, cerrada: true })];
    for (let d = 1; d <= 14; d++) rows.push(row(`g${d}`, 'h-gym', 'Gym', `2026-10-${String(d).padStart(2, '0')}`, '⚡ Hecho'));
    const { app } = fakeApp('2026-10-15T08:05:00Z', rows);
    await closeDays(app);
    // La ventana arranca el 01: hereda 30 y suma los 14 días
    expect(num(rows.find((x) => x.id === 'g14'), 'Racha')).toBe(44);
  });
});

describe('recalcular', () => {
  it('reconstruye desde el historial y lo deja en la última fila', async () => {
    const { app, rows } = fakeApp(NOW, [
      row('g12', 'h-gym', 'Gym', '2026-10-12', '⚡ Hecho', { r: 99, c: 0, cerrada: true }),
      row('g13', 'h-gym', 'Gym', '2026-10-13', '💤 Omitido'),
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    ]);
    const r = await recalcular(app);
    expect(r.habitos).toBe(1);
    const g13 = rows.find((x) => x.id === 'g13');
    expect([num(g13, 'Racha'), num(g13, 'Congeladores'), cerrada(g13)]).toEqual([1, 1, true]);
    expect(cerrada(rows.find((x) => x.id === 'g14'))).toBe(false);
  });
});

describe('runScheduled', () => {
  it('envía el aviso de la mañana una sola vez aunque el cron se repita, con la racha', async () => {
    // 2026-10-14 06:30 en Lima = 11:30 UTC
    const { app, sent, kv } = fakeApp('2026-10-14T11:30:00Z', [
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar', { r: 4, c: 2, cerrada: false }),
      row('a14', 'h-agua', 'Agua', '2026-10-14', '⚡ Hecho'),
    ]);
    await runScheduled(app);
    await runScheduled(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Buenos días');
    expect(sent[0]!.text).toContain('Gym');
    expect(sent[0]!.text).toContain('🔥4');
    expect(sent[0]!.text).not.toContain('Agua'); // ya registrado
    expect(kv.m.get('sent:2026-10-14:manana')).toBe('hecho');
  });

  it('un mensaje por pendiente: solo el primero lleva cabecera y suena', async () => {
    const { app, sent } = fakeApp('2026-10-14T11:30:00Z', [
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
      row('a14', 'h-agua', 'Agua', '2026-10-14', '⚪ Sin iniciar'),
    ]);
    await runScheduled(app);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain('Buenos días');
    expect(sent[0]!.silent).toBeFalsy();
    expect(sent[1]!.text).not.toContain('Buenos días');
    expect(sent[1]!.silent).toBe(true);
  });

  it('no envía nada si no hay pendientes en el bloque', async () => {
    const { app, sent } = fakeApp('2026-10-14T11:30:00Z', [row('a14', 'h-agua', 'Agua', '2026-10-14', '⚡ Hecho')]);
    await runScheduled(app);
    expect(sent).toHaveLength(0);
  });
});

describe('agrupar tarjetas', () => {
  it('tarjetasABorrar: registradas, reemplazadas y de otros días; deja las pendientes no repetidas', () => {
    const hoy = [
      { pageId: 'p-hecho', estado: 'hecho' },
      { pageId: 'p-pend', estado: 'sin_iniciar' },
      { pageId: 'p-repite', estado: 'sin_iniciar' },
    ] as any[];
    const cards = [
      { mid: 1, pageId: 'p-hecho', date: '2026-10-14' },
      { mid: 2, pageId: 'p-pend', date: '2026-10-14' },
      { mid: 3, pageId: 'p-repite', date: '2026-10-14' },
      { mid: 4, pageId: 'p-ayer', date: '2026-10-13' },
    ];
    const borrar = tarjetasABorrar(cards, hoy, '2026-10-14', new Set(['p-repite']));
    expect(borrar.map((c) => c.mid)).toEqual([1, 3, 4]);
  });

  it('el aviso de la tarde borra la tarjeta de la mañana que repite y la ya registrada', async () => {
    const rows = [
      row('agua', 'h-agua', 'Agua', '2026-10-14', '⚪ Sin iniciar'),
      row('gym', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
    ];
    rows[0]!.properties['Rango horario'].select.name = '❇️ Durante el día';
    rows[1]!.properties['Rango horario'].select.name = '🌆 12:00 a 17:59';
    // 06:30 Lima: llega la tarjeta de Agua (durante el día)
    const m = fakeApp('2026-10-14T11:30:00Z', rows);
    await runScheduled(m.app);
    expect(m.sent.map((s) => s.text.includes('Agua'))).toEqual([true]);
    // 12:30 Lima, misma KV: Agua sigue pendiente → se reemplaza; llega también Gym
    const t = fakeApp('2026-10-14T17:30:00Z', rows);
    t.app.kv = m.app.kv;
    await runScheduled(t.app);
    expect(t.deleted).toEqual([1]);
    expect(t.sent).toHaveLength(2);
  });
});

describe('«durante el día» en los 6 avisos', () => {
  const agua = (racha?: { r: number; c: number; cerrada: boolean }) => {
    const r = row('agua', 'h-agua', 'Agua', '2026-10-14', '⚪ Sin iniciar', racha);
    r.properties['Rango horario'].select.name = '❇️ Durante el día';
    return [r];
  };

  it('reaparece en el último llamado de la mañana, el de la tarde y la noche, borrando la tarjeta anterior', async () => {
    const rows = agua();
    // 10:30, 16:30 y 18:30 Lima (misma KV: la tarjeta viva pasa de un aviso al siguiente)
    const a = fakeApp('2026-10-14T15:30:00Z', rows);
    await runScheduled(a.app);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.text).toContain('Último llamado de la mañana');
    for (const [hora, titulo] of [
      ['2026-10-14T21:30:00Z', 'Último llamado de la tarde'],
      ['2026-10-14T23:30:00Z', 'Bloque de la noche'],
    ] as const) {
      const s = fakeApp(hora, rows);
      s.app.kv = a.app.kv;
      await runScheduled(s.app);
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0]!.text).toContain(titulo);
      expect(s.sent[0]!.text).toContain('Agua');
      expect(s.deleted).toEqual([1]); // la tarjeta del aviso anterior
    }
  });

  it('cuenta para la racha en riesgo del último llamado de la tarde', async () => {
    const { app, sent } = fakeApp('2026-10-14T21:30:00Z', agua({ r: 9, c: 0, cerrada: false }));
    await runScheduled(app);
    expect(sent[0]!.silent).toBeFalsy();
    expect(sent[0]!.text).toContain('Racha en riesgo');
  });
});

describe('balance mensual', () => {
  // 31/10 23:05 en Lima = 01/11 04:05 UTC
  const FIN_DE_MES = '2026-11-01T04:05:00Z';
  const filas = () => [
    row('g30', 'h-gym', 'Gym', '2026-10-30', '⚡ Hecho'),
    row('g31', 'h-gym', 'Gym', '2026-10-31', '⚡ Hecho'),
    row('a31', 'h-agua', 'Agua', '2026-10-31', '⚪ Sin iniciar'),
  ];

  it('el último día del mes llega tras el cierre, una sola vez, y deja el snapshot para el mes siguiente', async () => {
    const { app, sent, kv } = fakeApp(FIN_DE_MES, filas());
    await runScheduled(app);
    await runScheduled(app);
    const mes = sent.filter((s) => s.text.includes('Balance de octubre 2026'));
    expect(mes).toHaveLength(1);
    expect(sent.findIndex((s) => s.text.includes('Cierre del día'))).toBeLessThan(sent.indexOf(mes[0]!));
    expect(mes[0]!.text).toContain('📈 Cifras');
    expect(kv.m.get('sent:2026-10-31:mes')).toBe('hecho');
    expect(JSON.parse(kv.m.get('resumen:mes:2026-10')!).total).toEqual({ ok: 2, tot: 3 });
  });

  it('compara con el snapshot del mes anterior', async () => {
    const { app, sent, kv } = fakeApp(FIN_DE_MES, filas());
    kv.m.set('resumen:mes:2026-09', JSON.stringify({ desde: '2026-09-01', hasta: '2026-09-30', total: { ok: 9, tot: 10 }, porHabito: {}, porRango: {} }));
    await runScheduled(app);
    expect(sent.find((s) => s.text.includes('Balance de octubre'))!.text).toContain('vs. el mes anterior (90 %)');
  });

  it('un día cualquiera no envía el balance', async () => {
    const { app, sent } = fakeApp('2026-10-15T04:05:00Z', [row('g14', 'h-gym', 'Gym', '2026-10-14', '🔥 Completo')]);
    await runScheduled(app);
    expect(sent.some((s) => s.text.includes('Balance de'))).toBe(false);
  });

  it('si falla, no repite el cierre y se reintenta en el ciclo siguiente', async () => {
    const { app, sent, kv } = fakeApp(FIN_DE_MES, filas());
    const send = app.tg.send.bind(app.tg);
    let fallar = true;
    app.tg.send = (async (...a: Parameters<typeof send>) => {
      if (fallar && String(a[1]).includes('Balance de')) throw new Error('Telegram 500');
      return send(...a);
    }) as typeof app.tg.send;
    await runScheduled(app);
    expect(kv.m.has('sent:2026-10-31:mes')).toBe(false);
    fallar = false;
    await runScheduled(app);
    expect(sent.filter((s) => s.text.includes('Cierre del día'))).toHaveLength(1);
    expect(sent.filter((s) => s.text.includes('Balance de octubre'))).toHaveLength(1);
  });
});

describe('recordatorio inteligente (últimos llamados)', () => {
  // 2026-10-14 10:30 en Lima = 15:30 UTC → toca manana_ultimo
  const ULTIMO = '2026-10-14T15:30:00Z';
  const conRacha = (r: number, c: number) => [row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar', { r, c, cerrada: false })];

  it('llega en silencio si fallarlo no cuesta la racha (racha 0)', async () => {
    const { app, sent } = fakeApp(ULTIMO, conRacha(0, 2));
    await runScheduled(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.silent).toBe(true);
  });

  it('llega en silencio si aún queda un congelador', async () => {
    const { app, sent } = fakeApp(ULTIMO, conRacha(12, 1));
    await runScheduled(app);
    expect(sent[0]!.silent).toBe(true);
    expect(sent[0]!.text).not.toContain('Racha en riesgo');
  });

  it('suena y lo avisa si hay racha y no quedan congeladores', async () => {
    const { app, sent } = fakeApp(ULTIMO, conRacha(12, 0));
    await runScheduled(app);
    expect(sent[0]!.silent).toBeFalsy();
    expect(sent[0]!.text).toContain('⚠️ <b>Racha en riesgo, sin 🧊:</b> «Gym» (12 días)');
  });

  it('los avisos principales siempre suenan', async () => {
    // 06:30 Lima, racha 0
    const { app, sent } = fakeApp('2026-10-14T11:30:00Z', conRacha(0, 2));
    await runScheduled(app);
    expect(sent[0]!.silent).toBeFalsy();
  });
});

describe('precarga de Matrices', () => {
  it('en un ciclo sin aviso lee las que faltan y luego deja de consultar ese día', async () => {
    // 14:00 Lima: no toca ningún bloque
    const { app, kv } = fakeApp('2026-10-14T19:00:00Z', [row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar')]);
    await runScheduled(app);
    expect(kv.m.has('matrix:h-gym')).toBe(true);
    expect(kv.m.get('matrices:ok:2026-10-14')).toBe('1');
  });
  it('no precarga en un ciclo con aviso (protege el límite de llamadas)', async () => {
    const { app, kv } = fakeApp('2026-10-14T11:30:00Z', [row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar')]);
    await runScheduled(app);
    expect(kv.m.has('matrices:ok:2026-10-14')).toBe(false);
  });
});

describe('prioridad de Matrices', () => {
  it('lee primero la Matriz de las tarjetas que se van a mostrar, sin repetir hábitos', async () => {
    const { app } = fakeApp('2026-10-14T19:00:00Z', []);
    const leidas: string[] = [];
    app.notion.children = async (id: string) => {
      leidas.push(id);
      return [];
    };
    const e = (pageId: string, habitId: string) => ({ pageId, habitId, nombre: pageId, estado: null, fecha: '2026-10-14', rango: null, objetivo: '', identidad: '' });
    await matricesFor(app, [e('p-noche', 'h-noche'), e('p-gym', 'h-gym'), e('p-noche', 'h-noche')], 1);
    expect(leidas).toEqual(['p-noche']);
  });
});

describe('auditoría 2026-10-12', () => {
  it('hábito pausado (sin fila en el inicio de la ventana) conserva su última racha cerrada', async () => {
    // Última fila cerrada el 10/09; vuelve el 05/10. Los días sin fila son neutros.
    const rows: any[] = [row('old', 'h-gym', 'Gym', '2026-09-10', '⚡ Hecho', { r: 20, c: 1, cerrada: true })];
    for (let d = 5; d <= 14; d++) rows.push(row(`g${d}`, 'h-gym', 'Gym', `2026-10-${String(d).padStart(2, '0')}`, '⚡ Hecho'));
    const { app } = fakeApp('2026-10-15T08:05:00Z', rows);
    await closeDays(app);
    expect(num(rows.find((x) => x.id === 'g14'), 'Racha')).toBe(30);
  });

  it('las notas del cierre llegan aunque la mañana no tenga pendientes', async () => {
    const { app, sent, kv } = fakeApp('2026-10-14T11:30:00Z', [row('a14', 'h-agua', 'Agua', '2026-10-14', '⚡ Hecho')]);
    kv.m.set('notas:2026-10-14', '🧊 «Gym» usó un congelador (lun 13/10).');
    await runScheduled(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Buenos días');
    expect(sent[0]!.text).toContain('«Gym» usó un congelador');
  });

  it('sin filas de hoy el bloque no queda como enviado (se reintenta) ni cuenta como error', async () => {
    const { app, kv } = fakeApp('2026-10-14T11:30:00Z', []);
    await runScheduled(app);
    expect(kv.m.has('sent:2026-10-14:manana')).toBe(false);
    expect(kv.m.has('errores:2026-10-14')).toBe(false);
  });
});

describe('nunca falles dos veces', () => {
  it('el cierre anota quién falló ayer y su tarjeta de hoy lo dice con la versión mínima', async () => {
    const rows = [
      row('g13', 'h-gym', 'Gym', '2026-10-13', '⚪ Sin iniciar', { r: 3, c: 2, cerrada: false }),
      row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar'),
      row('a13', 'h-agua', 'Agua', '2026-10-13', '⚡ Hecho'),
      row('a14', 'h-agua', 'Agua', '2026-10-14', '⚪ Sin iniciar'),
    ];
    const c = fakeApp(NOW, rows);
    await closeDays(c.app);
    expect(JSON.parse(c.kv.m.get('fallos:2026-10-14')!)).toEqual(['h-gym']);

    const m = fakeApp('2026-10-14T11:30:00Z', rows);
    m.app.kv = c.app.kv;
    c.kv.m.set('matrix:h-gym', JSON.stringify({ senal: 'Ropa lista', protocolo: { parcial: '10 sentadillas' } }));
    await runScheduled(m.app);
    const gym = m.sent.find((s) => s.text.includes('<b>Gym</b>'))!;
    const agua = m.sent.find((s) => s.text.includes('<b>Agua</b>'))!;
    expect(gym.text).toContain('⚠️ <i>Ayer no salió: no falles dos veces.</i>\n🕯️ Mínimo: <i>10 sentadillas</i>\n💡 <i>Ropa lista</i>');
    expect(agua.text).not.toContain('no falles dos veces');
  });
});

describe('alertas de salud', () => {
  it('avisa una sola vez si un bloque falló en todos sus reintentos', async () => {
    const rows = [row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar')];
    // 06:30 Lima: Telegram falla al enviar el aviso.
    const f = fakeApp('2026-10-14T11:30:00Z', rows);
    f.app.tg.send = async () => {
      throw new Error('Telegram 500: caído');
    };
    await runScheduled(f.app);
    expect(JSON.parse(f.kv.m.get('errores:2026-10-14')!)).toHaveProperty('manana');
    // 07:45 Lima: pasó la ventana del bloque; un ciclo sin aviso revisa la salud.
    const s = fakeApp('2026-10-14T12:45:00Z', rows);
    s.app.kv = f.app.kv;
    await runScheduled(s.app);
    await runScheduled(s.app);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toContain('Revisión del bot');
    expect(s.sent[0]!.text).toContain('Falló el aviso «☀️ Buenos días»');
  });

  it('no avisa mientras el bloque aún puede reintentarse', async () => {
    const f = fakeApp('2026-10-14T11:30:00Z', []);
    f.kv.m.set('errores:2026-10-14', JSON.stringify({ manana: 'x' }));
    expect(await revisarSalud(f.app)).not.toContain('manana');
  });

  it('avisa si Notion no creó las filas de hoy (recurrencias apagadas), una vez', async () => {
    // 06:10 Lima: no toca ningún bloque.
    const { app, sent } = fakeApp('2026-10-14T11:10:00Z', []);
    await runScheduled(app);
    await runScheduled(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('recurrencia diaria activada');
  });

  it('avisa si el coach de IA falló, y sugiere recargar si es falta de saldo', async () => {
    const { app, sent, kv } = fakeApp('2026-10-14T11:10:00Z', [row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar')]);
    kv.m.set('salud:llm:2026-10-14', 'Error: LLM 402: Insufficient Balance');
    await runScheduled(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('recarga tu cuenta de DeepSeek');
  });
});

describe('recalcular con tope de llamadas', () => {
  it('se corta antes del límite y al repetirlo termina sin reescribir lo ya hecho', async () => {
    const rows: any[] = [];
    for (let h = 0; h < 25; h++) {
      rows.push(row(`r${h}a`, `h-${h}`, `H${h}`, '2026-10-13', '⚡ Hecho'));
      rows.push(row(`r${h}b`, `h-${h}`, `H${h}`, '2026-10-14', '⚪ Sin iniciar'));
    }
    const { app, updates } = fakeApp(NOW, rows);
    const r1 = await recalcular(app);
    expect(r1.incompleto).toBe(true);
    expect(updates.length).toBeLessThanOrEqual(40);
    const n1 = updates.length;
    const r2 = await recalcular(app);
    expect(r2).toMatchObject({ incompleto: false, habitos: 25, total: 25 });
    expect(updates.length - n1).toBe(50 - n1);
    for (let h = 0; h < 25; h++) expect(num(rows.find((x) => x.id === `r${h}b`), 'Racha')).toBe(1);
  });
});

describe('alerta del cierre de las 23:00', () => {
  it('si falló, se avisa al día siguiente (su ventana termina a medianoche)', async () => {
    const { app, sent, kv } = fakeApp('2026-10-14T11:10:00Z', [row('g14', 'h-gym', 'Gym', '2026-10-14', '⚪ Sin iniciar')]);
    kv.m.set('errores:2026-10-13', JSON.stringify({ cierre: 'LLM 500', manana: 'ya avisado ayer' }));
    await runScheduled(app);
    await runScheduled(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Cierre del día');
    expect(sent[0]!.text).not.toContain('Buenos días');
  });

  it('el coach del cierre espera hasta TIMEOUT_CRON_MS (en el cron no hay corte a los 30 s)', async () => {
    // Miércoles 14/10, 23:05 en Lima = 04:05 UTC del 15.
    const { app } = fakeApp('2026-10-15T04:05:00Z', [row('g14', 'h-gym', 'Gym', '2026-10-14', '🔥 Completo')]);
    const timeouts: (number | undefined)[] = [];
    app.llm = (async (o) => {
      timeouts.push(o.timeoutMs);
      return { content: 'ok', toolCalls: [], provider: 'openai-compatible' as const };
    }) as typeof app.llm;
    await runScheduled(app);
    expect(timeouts).toEqual([TIMEOUT_CRON_MS]);
  });
});

describe('alertas de salud: horario', () => {
  it('de madrugada no avisa (espera a las 06:00 para no despertar)', async () => {
    // 02:00 Lima, sin filas de hoy.
    const { app, sent } = fakeApp('2026-10-14T07:00:00Z', []);
    await runScheduled(app);
    expect(sent).toHaveLength(0);
  });

  it('hábitos sin relación (agrupados por nombre) también recuperan su última racha cerrada', async () => {
    const sinRelacion = (id: string, fecha: string, racha?: { r: number; c: number; cerrada: boolean }) => {
      const r: any = row(id, 'x', 'Leer', fecha, '⚡ Hecho', racha);
      r.properties['Estadística '].relation = [];
      return r;
    };
    const rows: any[] = [sinRelacion('old', '2026-09-10', { r: 8, c: 2, cerrada: true })];
    for (let d = 5; d <= 14; d++) rows.push(sinRelacion(`l${d}`, `2026-10-${String(d).padStart(2, '0')}`));
    const { app } = fakeApp('2026-10-15T08:05:00Z', rows);
    await closeDays(app);
    expect(num(rows.find((x) => x.id === 'l14'), 'Racha')).toBe(18);
  });
});
