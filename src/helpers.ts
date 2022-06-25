import { Config } from '../types'

export const isFunction = (value: any): value is Function =>
  typeof value === 'function'

type Nil = null | undefined

export const isNil = (value: any): value is Nil =>
  typeof value === 'undefined' || value === null

export const isPlainObject = (value: any) =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export const passThrough = (value: any) => value

export function parseConfig(config: Config) {
  if (!isPlainObject(config)) {
    throw new Error('Config is required')
  }

  const storage = config.storage

  if (
    !isPlainObject(storage) ||
    !isFunction(storage.getItem) ||
    !isFunction(storage.setItem)
  ) {
    throw new Error(
      'Storage is required and should satisfy the Config["storage"] type'
    )
  }

  const minTimeToStale = config.minTimeToStale || 0
  const maxTimeToLive =
    Math.min(config.maxTimeToLive!, Number.MAX_SAFE_INTEGER) || Infinity
  const serialize = isFunction(config.serialize)
    ? config.serialize
    : passThrough
  const deserialize = isFunction(config.deserialize)
    ? config.deserialize
    : passThrough

  const staleRevalidateTimeout = config.staleRevalidateTimeout || 10000

  if (minTimeToStale >= maxTimeToLive) {
    throw new Error('minTimeToStale must be less than maxTimeToLive')
  }

  if (config.staleRevalidateTimeout && !isFunction(storage.removeItem)) {
    throw new Error(
      'When using staleRevalidateTimeout, your storage object must specify a removeItem function'
    )
  }

  return {
    storage,
    minTimeToStale,
    maxTimeToLive,
    serialize,
    deserialize,
    staleRevalidateTimeout,
  }
}
