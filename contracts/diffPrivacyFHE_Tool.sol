pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DiffPrivacyFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool active;
        uint256 recordCount;
        uint256 noiseMagnitude; // Encrypted noise magnitude for this batch
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => euint32) public encryptedData; // batchId -> encrypted data
    mapping(uint256 => euint32) public encryptedNoisyResults; // batchId -> encrypted noisy result

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId, uint256 noiseMagnitude);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint32 dataValue);
    event NoiseMagnitudeSet(uint256 indexed batchId, uint32 noiseMagnitude);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 result);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error InvalidBatch();
    error BatchNotActive();
    error ReplayDetected();
    error StateMismatch();
    error InvalidNoiseMagnitude();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier respectCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier respectDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        currentBatchId = 0;
        cooldownSeconds = 30; // Default cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldown, newCooldown);
    }

    function openBatch(uint32 initialNoiseMagnitude) external onlyOwner whenNotPaused {
        currentBatchId++;
        Batch storage newBatch = batches[currentBatchId];
        newBatch.id = currentBatchId;
        newBatch.active = true;
        newBatch.recordCount = 0;
        newBatch.noiseMagnitude = FHE.asEuint32(initialNoiseMagnitude);
        emit BatchOpened(currentBatchId, initialNoiseMagnitude);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        Batch storage batch = batches[batchId];
        if (!batch.active) revert BatchNotActive();
        batch.active = false;
        emit BatchClosed(batchId);
    }

    function setNoiseMagnitude(uint256 batchId, uint32 newNoiseMagnitude) external onlyOwner whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        Batch storage batch = batches[batchId];
        if (!batch.active) revert BatchNotActive();
        batch.noiseMagnitude = FHE.asEuint32(newNoiseMagnitude);
        emit NoiseMagnitudeSet(batchId, newNoiseMagnitude);
    }

    function submitData(uint256 batchId, uint32 dataValue) external onlyProvider whenNotPaused respectCooldown {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        Batch storage batch = batches[batchId];
        if (!batch.active) revert BatchNotActive();

        euint32 memory encryptedDataValue = FHE.asEuint32(dataValue);
        euint32 memory currentEncryptedData = encryptedData[batchId];
        if (!FHE.isInitialized(currentEncryptedData)) {
            encryptedData[batchId] = encryptedDataValue;
        } else {
            encryptedData[batchId] = currentEncryptedData.add(encryptedDataValue);
        }
        batch.recordCount++;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, batchId, dataValue);
    }

    function requestNoisyResult(uint256 batchId) external whenNotPaused respectDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        Batch storage batch = batches[batchId];
        if (batch.active) revert BatchNotActive(); // Must be closed
        if (batch.recordCount == 0) revert InvalidBatch(); // No data to process

        euint32 memory encryptedSum = encryptedData[batchId];
        if (!FHE.isInitialized(encryptedSum)) revert NotInitialized("Encrypted sum not initialized for batch");
        euint32 memory encryptedNoise = batch.noiseMagnitude;
        if (!FHE.isInitialized(encryptedNoise)) revert NotInitialized("Encrypted noise magnitude not initialized for batch");

        euint32 memory encryptedNoisySum = encryptedSum.add(encryptedNoise);
        encryptedNoisyResults[batchId] = encryptedNoisySum;

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedNoisySum);

        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // Rebuild cts array in the exact same order as in requestNoisyResult
        euint32 memory currentEncryptedNoisyResult = encryptedNoisyResults[ctx.batchId];
        if (!FHE.isInitialized(currentEncryptedNoisyResult)) revert NotInitialized("Encrypted noisy result not found or uninitialized");
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(currentEncryptedNoisyResult);

        // State Verification: Re-calculate hash and compare
        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));
        if (currentHash != ctx.stateHash) revert StateMismatch();

        // Proof Verification
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode & Finalize
        uint32 result = abi.decode(cleartexts, (uint32));
        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, result);
    }

    // Internal helper functions
    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage eVar, uint32 clearValue) internal {
        if (!FHE.isInitialized(eVar)) {
            eVar = FHE.asEuint32(clearValue);
        }
    }

    function _requireInitialized(euint32 eVar) internal pure {
        if (!FHE.isInitialized(eVar)) revert NotInitialized();
    }
}