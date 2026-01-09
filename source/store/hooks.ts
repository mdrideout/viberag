/**
 * Typed Redux hooks for use in React components.
 *
 * Use these instead of plain `useDispatch` and `useSelector`
 * to get proper TypeScript inference.
 */

import {useDispatch, useSelector} from 'react-redux';
import type {RootState, AppDispatch} from './store.js';

/**
 * Typed useDispatch hook.
 * Returns a dispatch function with proper action type inference.
 */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();

/**
 * Typed useSelector hook.
 * Provides proper state type inference for selectors.
 */
export const useAppSelector = useSelector.withTypes<RootState>();
