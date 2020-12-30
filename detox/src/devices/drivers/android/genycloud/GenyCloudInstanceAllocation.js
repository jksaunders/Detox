const AndroidDeviceAllocator = require('../AndroidDeviceAllocator');
const GenyCloudInstanceHandle = require('./GenyCloudInstanceHandle');
const retry = require('../../../../utils/retry');
const logger = require('../../../../utils/logger').child({ __filename });

class GenyCloudInstanceAllocation extends AndroidDeviceAllocator {
  constructor(deviceRegistry, deviceCleanupRegistry, instanceLookupService, instanceLifecycleService, eventEmitter) {
    super(deviceRegistry, logger);

    this.deviceCleanupRegistry = deviceCleanupRegistry;
    this.instanceLookupService = instanceLookupService;
    this.instanceLifecycleService = instanceLifecycleService;
    this.eventEmitter = eventEmitter;
  }

  async allocateDevice(recipe) {
    let { instance, isNew } = await this._doSynchronizedAllocation(recipe);

    if (isNew) {
      const instanceHandle = new GenyCloudInstanceHandle(instance);
      await this.deviceCleanupRegistry.allocateDevice(instanceHandle);
    }

    instance = await this._waitForInstanceBoot(instance);
    instance = await this._adbConnectIfNeeded(instance);

    await this._notifyAllocation(instance, recipe, isNew);
    return instance;
  }

  async deallocateDevice(instance) {
    const instanceHandle = new GenyCloudInstanceHandle(instance);

    await this.eventEmitter.emit('beforeShutdownDevice', { deviceId: instance.adbName });
    await this.instanceLifecycleService.deleteInstance(instance.uuid);
    await this.deviceCleanupRegistry.disposeDevice(instanceHandle);
    await this.eventEmitter.emit('shutdownDevice', { deviceId: instance.adbName });
  }

  async _doSynchronizedAllocation(recipe) {
    let instance = null;
    let isNew = false;

    this._preAllocate(recipe);
    await this.deviceRegistry.allocateDevice(async () => {
      instance = await this.instanceLookupService.findFreeInstance();
      if (!instance) {
        instance = await this.instanceLifecycleService.createInstance(recipe.uuid);
        isNew = true;
      }
      return instance.uuid;
    });
    this._postAllocate(recipe, instance);

    return {
      instance,
      isNew,
    }
  }

  async _waitForInstanceBoot(instance) {
    if (instance.isOnline()) {
      return instance;
    }

    const options = {
      backoff: 'none', // TODO apply reverse-linear polling
      retries: 18,
      interval: 10000,
    };

    return await retry(options, async () => {
      const _instance = await this.instanceLookupService.getInstance(instance.uuid);
      if (!_instance.isOnline()) {
        throw new Error(`Timeout waiting for instance ${instance.uuid} to be ready`);
      }
      return _instance;
    });
  }

  async _adbConnectIfNeeded(instance) {
    if (!instance.isAdbConnected()) {
      instance = await this.instanceLifecycleService.adbConnectInstance(instance.uuid);
    }
    return instance;
  }

  async _notifyAllocation(instance, recipe, isNew) {
    return this.eventEmitter.emit('bootDevice', { coldBoot: isNew, deviceId: instance.adbName, type: recipe.name });
  }
}

module.exports = GenyCloudInstanceAllocation;
