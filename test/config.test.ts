import { describe, expect, it } from 'vitest';
import { estadoFromName, findProp, normalize, rangoFromName } from '../src/config';
import { decodeCallback, encodeDeshacer, encodeEstado } from '../src/callback';

describe('normalize', () => {
  it('quita tildes, emojis, espacios sobrantes y mayúsculas', () => {
    expect(normalize('  Nombre del Hábito ')).toBe('nombre del habito');
    expect(normalize('🕯️ Parcial')).toBe('parcial');
  });
});

describe('estadoFromName', () => {
  it('reconoce los estados de la plantilla aunque cambien los emojis', () => {
    expect(estadoFromName('⚪ Sin iniciar')).toBe('sin_iniciar');
    expect(estadoFromName('💤 Omitido')).toBe('omitido');
    expect(estadoFromName('🕯️ Parcial')).toBe('parcial');
    expect(estadoFromName('⚡ Hecho')).toBe('hecho');
    expect(estadoFromName('🔥Superado')).toBe('superado');
    expect(estadoFromName('🚀 Alto impacto')).toBe('alto');
    expect(estadoFromName('Otro')).toBeNull();
    expect(estadoFromName(undefined)).toBeNull();
  });
});

describe('rangoFromName', () => {
  it('reconoce los rangos horarios', () => {
    expect(rangoFromName('🌃 00:00 a 05:59')).toBe('madrugada');
    expect(rangoFromName('☀️ 06:00 a 11:59')).toBe('manana');
    expect(rangoFromName('🌆 12:00 a 17:59')).toBe('tarde');
    expect(rangoFromName('🌙 18:00 a 23:59')).toBe('noche');
    expect(rangoFromName('❇️ Durante el día')).toBe('dia');
    expect(rangoFromName(null)).toBeNull();
  });
});

describe('findProp', () => {
  it('encuentra propiedades con espacio final o sin tilde', () => {
    const props = { 'Nombre del habito ': 1, 'Estadística ': 2, Estado: 3 };
    expect(findProp(props, 'Nombre del hábito')).toBe('Nombre del habito ');
    expect(findProp(props, 'Estadística')).toBe('Estadística ');
    expect(findProp(props, 'Fecha')).toBeUndefined();
  });
});

describe('callback_data', () => {
  it('codifica y decodifica en menos de 64 bytes', () => {
    const id = '3f727351-c367-80aa-bbbb-0123456789ab';
    const data = encodeEstado(id, 'hecho');
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual({ kind: 'estado', pageId: '3f727351c36780aabbbb0123456789ab', estado: 'hecho' });
  });
  it('↩️ deshacer vuelve a Sin iniciar', () => {
    expect(decodeCallback(encodeDeshacer('3f727351-c367-80aa-bbbb-0123456789ab'))).toEqual({ kind: 'estado', pageId: '3f727351c36780aabbbb0123456789ab', estado: 'sin_iniciar' });
  });
  it('los botones de número de la versión anterior ya no son válidos', () => {
    expect(decodeCallback('i:3f727351c36780aabbbb0123456789ab')).toBeNull();
  });
  it('rechaza datos malformados', () => {
    expect(decodeCallback('e:xyz:h')).toBeNull();
    expect(decodeCallback('e:3f727351c36780aabbbb0123456789ab:z')).toBeNull();
    expect(decodeCallback('')).toBeNull();
  });
});
