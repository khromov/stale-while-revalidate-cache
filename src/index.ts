import { isFunction, isNil, parseConfig } from './helpers'
import {
  EmitterMethods,
  getEmitter,
  extendWithEmitterMethods,
} from './event-emitter'
import { Config } from '../types'

export const EmitterEvents = {
  cacheHit: 'cacheHit',
  cacheMiss: 'cacheMiss',
  cacheStale: 'cacheStale',
  cacheExpired: 'cacheExpired',
  cacheGetFailed: 'cacheGetFailed',
  cacheSetFailed: 'cacheSetFailed',
  invoke: 'invoke',
  revalidate: 'revalidate',
  revalidateFailed: 'revalidateFailed',
  revalidateTimeoutNotExceeded: 'revalidateTimeoutNotExceeded',
} as const

type StaleWhileRevalidateCache = <ReturnValue extends unknown>(
  cacheKey: string | (() => string),
  fn: () => ReturnValue
) => Promise<ReturnValue>

type StaleWhileRevalidate = StaleWhileRevalidateCache & EmitterMethods

export function createStaleWhileRevalidateCache(
  config: Config
): StaleWhileRevalidate {
  const {
    storage,
    minTimeToStale,
    maxTimeToLive,
    serialize,
    deserialize,
    staleRevalidateTimeout,
  } = parseConfig(config)

  const emitter = getEmitter()

  async function staleWhileRevalidate<ReturnValue extends unknown>(
    cacheKey: string | (() => string),
    fn: () => ReturnValue
  ): Promise<ReturnValue> {
    emitter.emit(EmitterEvents.invoke, { cacheKey, fn })

    const key = isFunction(cacheKey) ? String(cacheKey()) : String(cacheKey)
    const timeKey = `${key}_time`
    const revalidateTimeoutKey = `${key}_revalidate`

    async function retrieveCachedValue() {
      try {
        let [cachedValue, cachedTime, revalidateTime] = await Promise.all([
          storage.getItem(key),
          storage.getItem(timeKey),
          storage.getItem(revalidateTimeoutKey),
        ])

        cachedValue = deserialize(cachedValue)

        if (isNil(cachedValue)) {
          return { cachedValue: null, cachedAge: 0, revalidateAge: false }
        }

        const now = Date.now()
        const cachedAge = now - Number(cachedTime)
        const revalidateAge = revalidateTime
          ? now - Number(revalidateTime)
          : false

        if (cachedAge > maxTimeToLive) {
          emitter.emit(EmitterEvents.cacheExpired, {
            cacheKey,
            cachedAge,
            cachedTime,
            cachedValue,
            maxTimeToLive,
          })
          cachedValue = null
        }

        return { cachedValue, cachedAge, revalidateAge }
      } catch (error) {
        emitter.emit(EmitterEvents.cacheGetFailed, { cacheKey, error })
        return { cachedValue: null, cachedAge: 0, revalidateAge: false }
      }
    }

    async function persistValue(result: ReturnValue) {
      try {
        await Promise.all([
          storage.setItem(key, serialize(result)),
          storage.setItem(timeKey, Date.now().toString()),
        ])
      } catch (error) {
        emitter.emit(EmitterEvents.cacheSetFailed, { cacheKey, error })
      }
    }

    async function revalidate(revalidateAge: number | boolean) {
      try {
        // Check that we don't have an ongoing revalidation before revalidating
        if (
          revalidateAge === false ||
          (typeof revalidateAge === 'number' &&
            revalidateAge > staleRevalidateTimeout)
        ) {
          emitter.emit(EmitterEvents.revalidate, { cacheKey, fn })

          try {
            await storage.setItem(revalidateTimeoutKey, Date.now().toString())
          } catch (error) {
            emitter.emit(EmitterEvents.cacheSetFailed, { cacheKey, error })
          }

          const result = await fn()

          try {
            await storage.removeItem(revalidateTimeoutKey)
          } catch (error) {
            emitter.emit(EmitterEvents.cacheSetFailed, { cacheKey, error })
          }

          // This does not have to be awaited, but the update could fail in the background
          await persistValue(result)
          return result
        }

        emitter.emit(EmitterEvents.revalidateTimeoutNotExceeded, { cacheKey })
        return null as ReturnValue
      } catch (error) {
        emitter.emit(EmitterEvents.revalidateFailed, { cacheKey, fn, error })
        throw error
      }
    }

    const {
      cachedValue,
      cachedAge,
      revalidateAge,
    } = await retrieveCachedValue()

    if (!isNil(cachedValue)) {
      emitter.emit(EmitterEvents.cacheHit, { cacheKey, cachedValue })

      if (cachedAge >= minTimeToStale) {
        emitter.emit(EmitterEvents.cacheStale, {
          cacheKey,
          cachedValue,
          cachedAge,
        })

        // Non-blocking so that revalidation runs while stale cache data is returned
        // Error handled in `revalidate` by emitting an event, so only need a no-op here
        revalidate(revalidateAge).catch(() => {})
      }

      return cachedValue as ReturnValue
    }

    emitter.emit(EmitterEvents.cacheMiss, { cacheKey, fn })

    return revalidate(false)
  }

  return extendWithEmitterMethods(emitter, staleWhileRevalidate)
}
