import { Prisma } from '@prisma/client';
import { D, Dec, dec } from '../lmsr/lmsr';

export const toDec = (v: Prisma.Decimal | string | number | null | undefined): Dec => dec(v ?? 0);
export const money = (v: Dec | Prisma.Decimal | string | number) => dec(v).toFixed(2);
export const shares = (v: Dec | Prisma.Decimal | string | number) => dec(v).toFixed(6);
export const ZERO = new D(0);
