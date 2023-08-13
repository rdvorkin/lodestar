import sinon, {SinonStubbedInstance} from "sinon";
import {use, expect} from "chai";
import chaiAsPromised from "chai-as-promised";
import {ssz} from "@lodestar/types";
import {ForkChoice} from "@lodestar/fork-choice";
import {ChainForkConfig} from "@lodestar/config";
import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {routes} from "@lodestar/api";
import {createBeaconConfig, createChainForkConfig, defaultChainConfig} from "@lodestar/config";
import {SyncState} from "../../../../../src/sync/interface.js";
import {ApiModules} from "../../../../../src/api/impl/types.js";
import {getValidatorApi} from "../../../../../src/api/impl/validator/index.js";
import {IClock} from "../../../../../src/util/clock.js";
import {testLogger} from "../../../../utils/logger.js";
import {BeaconChain} from "../../../../../src/chain/index.js";
import {ExecutionEngineHttp} from "../../../../../src/execution/engine/http.js";
import {StubbedBeaconDb, StubbedChainMutable} from "../../../../utils/stub/index.js";
import {Eth1ForBlockProduction, IEth1ForBlockProduction} from "../../../../../src/eth1/index.js";
import {BeaconProposerCache} from "../../../../../src/chain/beaconProposerCache.js";
import {Network} from "../../../../../src/network/index.js";
import {BeaconSync} from "../../../../../src/sync/index.js";
import {ExecutionBuilderHttp, IExecutionBuilder} from "../../../../../src/execution/index.js";

use(chaiAsPromised);

type StubbedChain = StubbedChainMutable<"clock" | "forkChoice" | "logger" | "config">;

/* eslint-disable @typescript-eslint/naming-convention */
describe("api/validator - produceBlockV3", function () {
  const logger = testLogger();
  const sandbox = sinon.createSandbox();

  let modules: ApiModules;

  let chainStub: StubbedChain;
  let forkChoiceStub: SinonStubbedInstance<ForkChoice> & ForkChoice;
  let eth1Stub: SinonStubbedInstance<Eth1ForBlockProduction>;
  let syncStub: SinonStubbedInstance<BeaconSync>;
  let beaconProposerCacheStub: SinonStubbedInstance<BeaconProposerCache> & BeaconProposerCache;
  let dbStub: StubbedBeaconDb;
  let networkStub: SinonStubbedInstance<Network>;
  let executionBuilderStub: SinonStubbedInstance<ExecutionBuilderHttp> & ExecutionBuilderHttp;

  const chainConfig = createChainForkConfig({
    ...defaultChainConfig,
    ALTAIR_FORK_EPOCH: 0,
    BELLATRIX_FORK_EPOCH: 1,
  });
  const genesisValidatorsRoot = Buffer.alloc(32, 0xaa);
  const config = createBeaconConfig(chainConfig, genesisValidatorsRoot);

  beforeEach(() => {
    const chainConfig = createChainForkConfig({
      ...defaultChainConfig,
      ALTAIR_FORK_EPOCH: 0,
      BELLATRIX_FORK_EPOCH: 1,
    });
    const genesisValidatorsRoot = Buffer.alloc(32, 0xaa);
    const config = createBeaconConfig(chainConfig, genesisValidatorsRoot);

    chainStub = sandbox.createStubInstance(BeaconChain) as StubbedChain;

    dbStub = new StubbedBeaconDb(config);
    networkStub = sinon.createStubInstance(Network);
    syncStub = sinon.createStubInstance(BeaconSync);

    eth1Stub = sinon.createStubInstance(Eth1ForBlockProduction);
    chainStub.logger = logger;
    forkChoiceStub = sandbox.createStubInstance(ForkChoice) as SinonStubbedInstance<ForkChoice> & ForkChoice;
    chainStub.forkChoice = forkChoiceStub;

    (chainStub as unknown as {eth1: IEth1ForBlockProduction}).eth1 = eth1Stub;
    (chainStub as unknown as {config: ChainForkConfig}).config = config as unknown as ChainForkConfig;

    beaconProposerCacheStub = sandbox.createStubInstance(
      BeaconProposerCache
    ) as SinonStubbedInstance<BeaconProposerCache> & BeaconProposerCache;
    (chainStub as unknown as {beaconProposerCache: BeaconProposerCache})["beaconProposerCache"] =
      beaconProposerCacheStub;

    executionBuilderStub = sandbox.createStubInstance(
      ExecutionBuilderHttp
    ) as SinonStubbedInstance<ExecutionBuilderHttp> & ExecutionEngineHttp;
    (chainStub as unknown as {executionBuilder: IExecutionBuilder}).executionBuilder = executionBuilderStub;
    executionBuilderStub.status = true;
  });
  afterEach(() => {
    sandbox.restore();
  });

  const testCases: [routes.validator.BuilderSelection, number | null, number | null, string][] = [
    [routes.validator.BuilderSelection.MaxProfit, 1, 0, "builder"],
    [routes.validator.BuilderSelection.MaxProfit, 1, 2, "engine"],
    [routes.validator.BuilderSelection.MaxProfit, null, 0, "engine"],
    [routes.validator.BuilderSelection.MaxProfit, 0, null, "builder"],

    [routes.validator.BuilderSelection.BuilderAlways, 1, 2, "builder"],
    [routes.validator.BuilderSelection.BuilderAlways, 1, 0, "builder"],
    [routes.validator.BuilderSelection.BuilderAlways, null, 0, "engine"],
    [routes.validator.BuilderSelection.BuilderAlways, 0, null, "builder"],

    [routes.validator.BuilderSelection.BuilderOnly, 0, 2, "builder"],
    [routes.validator.BuilderSelection.ExecutionOnly, 2, 0, "execution"],
  ];

  testCases.forEach(([builderSelection, builderPayloadValue, enginePayloadValue, finalSelection]) => {
    it(`produceBlockV3  - ${finalSelection} produces block`, async () => {
      modules = {
        chain: chainStub,
        config,
        db: dbStub,
        logger,
        network: networkStub,
        sync: syncStub,
        metrics: null,
      };

      const fullBlock = ssz.bellatrix.BeaconBlock.defaultValue();
      const blindedBlock = ssz.bellatrix.BlindedBeaconBlock.defaultValue();

      const slot = 1 * SLOTS_PER_EPOCH;
      const randaoReveal = fullBlock.body.randaoReveal;
      const graffiti = "a".repeat(32);
      const feeRecipient = "0xccccccccccccccccccccccccccccccccccccccaa";
      const currentSlot = 1 * SLOTS_PER_EPOCH;
      chainStub.clock = {currentSlot} as IClock;
      sinon.replaceGetter(syncStub, "state", () => SyncState.Synced);

      const api = getValidatorApi(modules);

      if (enginePayloadValue !== null) {
        chainStub.produceBlock.resolves({
          block: fullBlock,
          executionPayloadValue: BigInt(enginePayloadValue),
        });
      } else {
        chainStub.produceBlock.throws(Error("not produced"));
      }

      if (builderPayloadValue !== null) {
        chainStub.produceBlindedBlock.resolves({
          block: blindedBlock,
          executionPayloadValue: BigInt(builderPayloadValue),
        });
      } else {
        chainStub.produceBlindedBlock.throws(Error("not produced"));
      }

      const _skipRandaoVerification = false;
      const produceBlockOpts = {
        strictFeeRecipientCheck: false,
        builderSelection,
        feeRecipient,
      };

      const block = await api.produceBlockV3(slot, randaoReveal, graffiti, _skipRandaoVerification, produceBlockOpts);

      const expectedBlock = finalSelection === "builder" ? blindedBlock : fullBlock;
      const expectedExecution = finalSelection === "builder" ? true : false;

      expect(block.data).to.be.deep.equal(expectedBlock);
      expect(block.executionPayloadBlinded).to.be.equal(expectedExecution);

      // check call counts
      if (builderSelection === routes.validator.BuilderSelection.ExecutionOnly) {
        expect(chainStub.produceBlindedBlock.callCount).to.equal(0, "produceBlindedBlock should not be called");
      } else {
        expect(chainStub.produceBlindedBlock.callCount).to.equal(1, "produceBlindedBlock should be called");
      }

      if (builderSelection === routes.validator.BuilderSelection.BuilderOnly) {
        expect(chainStub.produceBlock.callCount).to.equal(0, "produceBlock should not be called");
      } else {
        expect(chainStub.produceBlock.callCount).to.equal(1, "produceBlock should be called");
      }
    });
  });
});
