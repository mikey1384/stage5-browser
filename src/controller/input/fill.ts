import { inputFillRefOperations } from './fill-ref.js';
import { inputFillRoleOperations } from './fill-role.js';

export const inputFillOperations = {
  ...inputFillRoleOperations,
  ...inputFillRefOperations,
};

export type InputFillOperations = typeof inputFillOperations;
