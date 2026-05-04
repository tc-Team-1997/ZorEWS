import clsx, { type ClassValue } from 'clsx';

/** Tiny wrapper around clsx so component code reads consistently. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
