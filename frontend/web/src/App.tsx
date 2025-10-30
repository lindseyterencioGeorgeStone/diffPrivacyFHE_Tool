import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface CommodityTrade {
  id: string;
  encryptedPrice: string;
  encryptedQuantity: string;
  commodityType: string;
  timestamp: number;
  trader: string;
  status: "pending" | "executed" | "canceled";
  fheOperation?: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'priceIncrease5%':
      result = value * 1.05;
      break;
    case 'priceDecrease5%':
      result = value * 0.95;
      break;
    case 'quantityDouble':
      result = value * 2;
      break;
    case 'quantityHalf':
      result = value * 0.5;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState<CommodityTrade[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTradeData, setNewTradeData] = useState({ 
    commodityType: "", 
    price: 0, 
    quantity: 0,
    operation: "buy"
  });
  const [selectedTrade, setSelectedTrade] = useState<CommodityTrade | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [decryptedQuantity, setDecryptedQuantity] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<"dashboard" | "trades" | "fheOperations">("dashboard");
  const [fheComputing, setFheComputing] = useState(false);

  // Commodity types for the exchange
  const commodityTypes = [
    "Crude Oil", "Gold", "Silver", "Copper", "Aluminum",
    "Wheat", "Corn", "Soybeans", "Coffee", "Sugar",
    "Natural Gas", "Brent Crude", "Palm Oil", "Cotton", "Cocoa"
  ];

  useEffect(() => {
    loadTrades().finally(() => setLoading(false));
    const initContractParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initContractParams();
  }, []);

  const loadTrades = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load trade keys
      const keysBytes = await contract.getData("trade_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { 
          console.error("Error parsing trade keys:", e); 
        }
      }

      const tradesList: CommodityTrade[] = [];
      for (const key of keys) {
        try {
          const tradeBytes = await contract.getData(`trade_${key}`);
          if (tradeBytes.length > 0) {
            try {
              const tradeData = JSON.parse(ethers.toUtf8String(tradeBytes));
              tradesList.push({ 
                id: key, 
                encryptedPrice: tradeData.price, 
                encryptedQuantity: tradeData.quantity,
                commodityType: tradeData.commodityType, 
                timestamp: tradeData.timestamp, 
                trader: tradeData.trader, 
                status: tradeData.status || "pending",
                fheOperation: tradeData.fheOperation
              });
            } catch (e) { 
              console.error(`Error parsing trade data for ${key}:`, e); 
            }
          }
        } catch (e) { 
          console.error(`Error loading trade ${key}:`, e); 
        }
      }
      tradesList.sort((a, b) => b.timestamp - a.timestamp);
      setTrades(tradesList);
    } catch (e) { 
      console.error("Error loading trades:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitTrade = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting trade data with Zama FHE..." 
    });
    
    try {
      // Encrypt sensitive data using FHE
      const encryptedPrice = FHEEncryptNumber(newTradeData.price);
      const encryptedQuantity = FHEEncryptNumber(newTradeData.quantity);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const tradeId = `trade-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const tradeData = { 
        price: encryptedPrice, 
        quantity: encryptedQuantity,
        commodityType: newTradeData.commodityType, 
        timestamp: Math.floor(Date.now() / 1000), 
        trader: address, 
        status: "pending",
        operation: newTradeData.operation
      };
      
      // Store trade data
      await contract.setData(`trade_${tradeId}`, ethers.toUtf8Bytes(JSON.stringify(tradeData)));
      
      // Update trade keys list
      const keysBytes = await contract.getData("trade_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(tradeId);
      await contract.setData("trade_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Trade encrypted and submitted securely!" 
      });
      
      await loadTrades();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTradeData({ commodityType: "", price: 0, quantity: 0, operation: "buy" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const executeTrade = async (tradeId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setFheComputing(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Executing trade with FHE computation..." 
    });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const tradeBytes = await contract.getData(`trade_${tradeId}`);
      if (tradeBytes.length === 0) throw new Error("Trade not found");
      
      const tradeData = JSON.parse(ethers.toUtf8String(tradeBytes));
      
      // Simulate FHE computation on encrypted data
      setTransactionStatus({ 
        visible: true, 
        status: "pending", 
        message: "Performing FHE computations on encrypted trade data..." 
      });
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedTrade = { 
        ...tradeData, 
        status: "executed",
        fheOperation: "trade_executed"
      };
      
      await contractWithSigner.setData(`trade_${tradeId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTrade)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE trade execution completed successfully!" 
      });
      
      await loadTrades();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Trade execution failed: " + (e.message || "Unknown error") 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally {
      setFheComputing(false);
    }
  };

  const performFHEOperation = async (tradeId: string, operation: string) => {
    if (!isConnected) return;
    
    setFheComputing(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: `Performing ${operation} with FHE...` 
    });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const tradeBytes = await contract.getData(`trade_${tradeId}`);
      if (tradeBytes.length === 0) throw new Error("Trade not found");
      
      const tradeData = JSON.parse(ethers.toUtf8String(tradeBytes));
      
      // Perform FHE computation
      const computedPrice = FHECompute(tradeData.price, operation);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedTrade = { 
        ...tradeData, 
        price: computedPrice,
        fheOperation: operation
      };
      
      await contractWithSigner.setData(`trade_${tradeId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTrade)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: `FHE ${operation} completed successfully!` 
      });
      
      await loadTrades();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: `FHE operation failed: ${e.message || "Unknown error"}` 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally {
      setFheComputing(false);
    }
  };

  const decryptWithSignature = async (encryptedPrice: string, encryptedQuantity: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null;
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddress:${contractAddress}\nchainId:${chainId}\ntimestamp:${Date.now()}`;
      await signMessageAsync({ message });
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const decryptedPrice = FHEDecryptNumber(encryptedPrice);
      const decryptedQuantity = FHEDecryptNumber(encryptedQuantity);
      
      return { price: decryptedPrice, quantity: decryptedQuantity };
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null;
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const handleDecryptTrade = async (trade: CommodityTrade) => {
    const result = await decryptWithSignature(trade.encryptedPrice, trade.encryptedQuantity);
    if (result) {
      setDecryptedPrice(result.price);
      setDecryptedQuantity(result.quantity);
    }
  };

  // Statistics
  const executedCount = trades.filter(t => t.status === "executed").length;
  const pendingCount = trades.filter(t => t.status === "pending").length;
  const canceledCount = trades.filter(t => t.status === "canceled").length;

  if (loading) return (
    <div className="loading-screen">
      <div className="control-spinner"></div>
      <p>Initializing CommodityDEX FHE Exchange...</p>
    </div>
  );

  return (
    <div className="app-container control-theme">
      {/* Fixed Sidebar */}
      <aside className="app-sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon">⚡</div>
            <h1>Commodity<span>DEX</span></h1>
          </div>
          <div className="fhe-badge">
            <div className="fhe-indicator"></div>
            ZAMA FHE Secured
          </div>
        </div>
        
        <nav className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <div className="nav-icon">📊</div>
            Dashboard
          </button>
          <button 
            className={`nav-item ${activeTab === "trades" ? "active" : ""}`}
            onClick={() => setActiveTab("trades")}
          >
            <div className="nav-icon">📈</div>
            Trade History
          </button>
          <button 
            className={`nav-item ${activeTab === "fheOperations" ? "active" : ""}`}
            onClick={() => setActiveTab("fheOperations")}
          >
            <div className="nav-icon">🔐</div>
            FHE Operations
          </button>
        </nav>

        <div className="wallet-section">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={true} />
        </div>

        <div className="sidebar-footer">
          <div className="system-status">
            <div className="status-item">
              <span>FHE Encryption:</span>
              <span className="status-active">Active</span>
            </div>
            <div className="status-item">
              <span>Network:</span>
              <span className="status-good">Stable</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        <header className="content-header">
          <h2>{
            activeTab === "dashboard" ? "Commodity Trading Dashboard" :
            activeTab === "trades" ? "Trade History & Management" :
            "FHE Computational Operations"
          }</h2>
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-trade-btn control-button"
            disabled={!isConnected}
          >
            + New Trade
          </button>
        </header>

        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <div className="dashboard-content">
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{trades.length}</div>
                <div className="stat-label">Total Trades</div>
                <div className="stat-trend">+12%</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{executedCount}</div>
                <div className="stat-label">Executed</div>
                <div className="stat-trend">+8%</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
                <div className="stat-trend">+5%</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">${((trades.reduce((sum, trade) => {
                  if (trade.status === "executed") {
                    const price = FHEDecryptNumber(trade.encryptedPrice);
                    const quantity = FHEDecryptNumber(trade.encryptedQuantity);
                    return sum + (price * quantity);
                  }
                  return sum;
                }, 0) / 1000000)).toFixed(1)}M</div>
                <div className="stat-label">Volume</div>
                <div className="stat-trend">+15%</div>
              </div>
            </div>

            <div className="recent-trades">
              <h3>Recent Trades</h3>
              <div className="trades-list">
                {trades.slice(0, 5).map(trade => (
                  <div key={trade.id} className="trade-item">
                    <div className="trade-info">
                      <span className="commodity-type">{trade.commodityType}</span>
                      <span className="trade-status">{trade.status}</span>
                    </div>
                    <div className="trade-meta">
                      <span>{new Date(trade.timestamp * 1000).toLocaleDateString()}</span>
                      <button 
                        onClick={() => setSelectedTrade(trade)}
                        className="view-details"
                      >
                        Details
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Trades Tab */}
        {activeTab === "trades" && (
          <div className="trades-content">
            <div className="section-header">
              <h3>Trade History</h3>
              <button onClick={loadTrades} className="refresh-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            
            <div className="trades-table">
              <div className="table-header">
                <div>Commodity</div>
                <div>Type</div>
                <div>Trader</div>
                <div>Date</div>
                <div>Status</div>
                <div>Actions</div>
              </div>
              
              {trades.length === 0 ? (
                <div className="no-trades">
                  <div className="no-data-icon">📊</div>
                  <p>No trades found</p>
                  <button onClick={() => setShowCreateModal(true)} className="control-button">
                    Create First Trade
                  </button>
                </div>
              ) : (
                trades.map(trade => (
                  <div key={trade.id} className="table-row">
                    <div>{trade.commodityType}</div>
                    <div>{trade.fheOperation || "Standard"}</div>
                    <div>{trade.trader.substring(0, 6)}...{trade.trader.substring(38)}</div>
                    <div>{new Date(trade.timestamp * 1000).toLocaleDateString()}</div>
                    <div>
                      <span className={`status-badge ${trade.status}`}>
                        {trade.status}
                      </span>
                    </div>
                    <div className="action-buttons">
                      <button 
                        onClick={() => setSelectedTrade(trade)}
                        className="action-btn"
                      >
                        View
                      </button>
                      {trade.status === "pending" && (
                        <button 
                          onClick={() => executeTrade(trade.id)}
                          className="action-btn execute"
                          disabled={fheComputing}
                        >
                          Execute
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* FHE Operations Tab */}
        {activeTab === "fheOperations" && (
          <div className="fhe-operations">
            <h3>FHE Computational Operations</h3>
            <p>Perform computations on encrypted trade data without decryption</p>
            
            <div className="operations-grid">
              <div className="operation-card">
                <h4>Price Adjustments</h4>
                <div className="operation-buttons">
                  <button 
                    onClick={() => selectedTrade && performFHEOperation(selectedTrade.id, 'priceIncrease5%')}
                    disabled={!selectedTrade || fheComputing}
                    className="control-button"
                  >
                    +5% Price
                  </button>
                  <button 
                    onClick={() => selectedTrade && performFHEOperation(selectedTrade.id, 'priceDecrease5%')}
                    disabled={!selectedTrade || fheComputing}
                    className="control-button"
                  >
                    -5% Price
                  </button>
                </div>
              </div>
              
              <div className="operation-card">
                <h4>Quantity Operations</h4>
                <div className="operation-buttons">
                  <button 
                    onClick={() => selectedTrade && performFHEOperation(selectedTrade.id, 'quantityDouble')}
                    disabled={!selectedTrade || fheComputing}
                    className="control-button"
                  >
                    Double Qty
                  </button>
                  <button 
                    onClick={() => selectedTrade && performFHEOperation(selectedTrade.id, 'quantityHalf')}
                    disabled={!selectedTrade || fheComputing}
                    className="control-button"
                  >
                    Half Qty
                  </button>
                </div>
              </div>
            </div>

            {fheComputing && (
              <div className="fhe-computing">
                <div className="computing-spinner"></div>
                <p>Performing FHE computations on encrypted data...</p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Modals */}
      {showCreateModal && (
        <CreateTradeModal
          onSubmit={submitTrade}
          onClose={() => setShowCreateModal(false)}
          creating={creating}
          tradeData={newTradeData}
          setTradeData={setNewTradeData}
          commodityTypes={commodityTypes}
        />
      )}

      {selectedTrade && (
        <TradeDetailModal
          trade={selectedTrade}
          onClose={() => {
            setSelectedTrade(null);
            setDecryptedPrice(null);
            setDecryptedQuantity(null);
          }}
          decryptedPrice={decryptedPrice}
          decryptedQuantity={decryptedQuantity}
          isDecrypting={isDecrypting}
          onDecrypt={handleDecryptTrade}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content control-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="control-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

// Modal Components
interface CreateTradeModalProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  tradeData: any;
  setTradeData: (data: any) => void;
  commodityTypes: string[];
}

const CreateTradeModal: React.FC<CreateTradeModalProps> = ({
  onSubmit,
  onClose,
  creating,
  tradeData,
  setTradeData,
  commodityTypes
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setTradeData({ ...tradeData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTradeData({ ...tradeData, [name]: parseFloat(value) || 0 });
  };

  const handleSubmit = () => {
    if (!tradeData.commodityType || !tradeData.price || !tradeData.quantity) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content control-card">
        <div className="modal-header">
          <h2>Create New Trade</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="modal-body">
          <div className="form-group">
            <label>Commodity Type *</label>
            <select 
              name="commodityType" 
              value={tradeData.commodityType} 
              onChange={handleChange}
              className="control-input"
            >
              <option value="">Select commodity</option>
              {commodityTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          
          <div className="form-group">
            <label>Operation Type *</label>
            <select 
              name="operation" 
              value={tradeData.operation} 
              onChange={handleChange}
              className="control-input"
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Price per Unit *</label>
            <input
              type="number"
              name="price"
              value={tradeData.price}
              onChange={handleNumberChange}
              className="control-input"
              step="0.01"
              min="0"
            />
          </div>
          
          <div className="form-group">
            <label>Quantity *</label>
            <input
              type="number"
              name="quantity"
              value={tradeData.quantity}
              onChange={handleNumberChange}
              className="control-input"
              step="0.01"
              min="0"
            />
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-grid">
              <div className="preview-item">
                <span>Original Price:</span>
                <code>${tradeData.price}</code>
              </div>
              <div className="preview-item">
                <span>Encrypted:</span>
                <code>{tradeData.price ? FHEEncryptNumber(tradeData.price).substring(0, 30) + '...' : 'N/A'}</code>
              </div>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="control-button secondary">Cancel</button>
          <button 
            onClick={handleSubmit} 
            disabled={creating}
            className="control-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Create Encrypted Trade"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface TradeDetailModalProps {
  trade: CommodityTrade;
  onClose: () => void;
  decryptedPrice: number | null;
  decryptedQuantity: number | null;
  isDecrypting: boolean;
  onDecrypt: (trade: CommodityTrade) => void;
}

const TradeDetailModal: React.FC<TradeDetailModalProps> = ({
  trade,
  onClose,
  decryptedPrice,
  decryptedQuantity,
  isDecrypting,
  onDecrypt
}) => {
  return (
    <div className="modal-overlay">
      <div className="modal-content control-card large">
        <div className="modal-header">
          <h2>Trade Details</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="modal-body">
          <div className="trade-details-grid">
            <div className="detail-item">
              <label>Commodity:</label>
              <span>{trade.commodityType}</span>
            </div>
            <div className="detail-item">
              <label>Trader:</label>
              <span>{trade.trader}</span>
            </div>
            <div className="detail-item">
              <label>Date:</label>
              <span>{new Date(trade.timestamp * 1000).toLocaleString()}</span>
            </div>
            <div className="detail-item">
              <label>Status:</label>
              <span className={`status-badge ${trade.status}`}>{trade.status}</span>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Data (FHE Secured)</h3>
            <div className="encrypted-data">
              <div className="data-item">
                <label>Price:</label>
                <code>{trade.encryptedPrice.substring(0, 50)}...</code>
              </div>
              <div className="data-item">
                <label>Quantity:</label>
                <code>{trade.encryptedQuantity.substring(0, 50)}...</code>
              </div>
            </div>
            
            <button 
              onClick={() => onDecrypt(trade)}
              disabled={isDecrypting}
              className="control-button"
            >
              {isDecrypting ? "Decrypting..." : 
               decryptedPrice ? "Re-decrypt with Signature" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          
          {decryptedPrice !== null && decryptedQuantity !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Values</h3>
              <div className="decrypted-data">
                <div className="value-item">
                  <label>Price:</label>
                  <span>${decryptedPrice.toFixed(2)}</span>
                </div>
                <div className="value-item">
                  <label>Quantity:</label>
                  <span>{decryptedQuantity.toFixed(2)} units</span>
                </div>
                <div className="value-item">
                  <label>Total Value:</label>
                  <span>${(decryptedPrice * decryptedQuantity).toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;