const express = require('express');
//const bodyParser = require('body-parser');
const fs = require('fs');
const rp = require('request-promise');
const Blockchain = require("./blockchain");
const EC = require('elliptic').ec;

const router = express.Router()

const currentNodeUrl = "http://" + process.env.NUXT_HOST + ":" + process.env.NUXT_PORT + "/api";

const walletFileName = "wallet" + currentNodeUrl.replace(/\//g, '') + ".txt";
const blockchainFileName = "blockchain" + currentNodeUrl.replace(/\//g, '') + ".txt";

// Create blockchain
const bitcoin = new Blockchain(blockchainFileName, walletFileName, currentNodeUrl);

// Create Wallet or Load Wallet if Walletfile available
const ec = new EC('secp256k1');
try {
  fs.statSync(bitcoin.walletFileName);
  console.log("Wallet file found: " + bitcoin.walletFileName);
  bitcoin.loadWalletFromFile();
} catch (error) {
  console.log("No wallet file");
  // const ec = new EC('secp256k1');
  const key = ec.genKeyPair();
  //const publicKey = key.getPublic('hex');
  const privateKey = key.getPrivate('hex');
  bitcoin.writeWalletFile(privateKey);
}

const signingKey = ec.keyFromPrivate(bitcoin.privateKey);

//Creating Genesis bloc if no blockchain file or load blockchain from file
try {
  fs.statSync(bitcoin.blockchainFileName);
  console.log("Blockchainfile found");
  bitcoin.loadBlockchainFromFile();
} catch (error) {
  console.log("Blockchainfile not found");
  bitcoin.createNewBlock(100, '0', '0');
}

// API 
router.get('/blockchain', function (req, res) {
  console.log("/blockchain reached");
  res.send(bitcoin);
})

router.post('/transaction', function(req, res) {
  const blockNumber = bitcoin.addTransactionToPendingTransaction(req.body);
  res.json( { note: 'Transaction will be added to block ' + blockNumber});

})

router.post('/transaction/broadcast', function(req, res) {
  // Verify if enough balance if not mining reward
  const addressTransactions = bitcoin.getTransactionsByAddress(req.body.sender);
  let balance = 0;
  // Calculate balance
  if (req.body.sender !== '00') {
    addressTransactions.forEach(transaction => {
      if (transaction.sender === req.body.sender) {
        balance -= transaction.amount;
      }
      if (transaction.recipient === req.body.sender) {
        balance += transaction.amount;
      }
    })
  }
  if (req.body.amount <= balance || req.body.sender === '00') {
    const newTransaction = bitcoin.createTransaction(req.body.amount, req.body.sender, req.body.recipient);
    newTransaction.signature = bitcoin.signTransaction(newTransaction, signingKey);
    if (bitcoin.transactionIsValid(newTransaction)) {
      bitcoin.addTransactionToPendingTransaction(newTransaction);
      // Broadcast transaction
      const reqNodesPromises = [];
      bitcoin.networkNodes.forEach(networkNodeUrl => {
        const requestOptions = {
          uri: networkNodeUrl + "/transaction",
          method: 'POST',
          body: newTransaction,
          json: true
        }
        reqNodesPromises.push(rp(requestOptions));
      })
      Promise.all(reqNodesPromises)
        .then(data => {
          res.json( { note: "Transaction added and broadcasted to all network nodes" } );
        })
        .catch(err => console.log(err));
      
    }else {
      res.json({
        note: 'Transaction is invalid'
      })
    }
  }else {
    res.json({
      note: 'Your balance is insuffisent',
      balance: balance
    })
    
  }
  
})

router.get('/mine', function (req, res) {
  const lastBlock = bitcoin.getLastBlock();
  const previousHash = lastBlock.hash;
 
  const currentBlockData = {
    transactions: bitcoin.pendingTransactions,
    index: lastBlock['index'] + 1
  }
  const nonce = bitcoin.proofOfWork(previousHash, currentBlockData);
  const hash = bitcoin.hashBlock(previousHash, currentBlockData, nonce);

  const newBlock = bitcoin.createNewBlock(nonce, previousHash, hash);

  // Broadcast new block
  const reqNodesPromises = [];
  bitcoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/receive-new-block',
      method: 'POST',
      body: { newBlock: newBlock },
      json: true
    };
    reqNodesPromises.push(rp(requestOptions));
  })
  Promise.all(reqNodesPromises)
    .then(data => {
      // Broadcast mining reward by hitting transaction/broadcast of our current node
      const miningRewardTransaction = bitcoin.createTransaction(12.5, "00", bitcoin.walletAddress);
      const requestOptions = {
        uri: bitcoin.currentNodeUrl + '/transaction/broadcast',
        method: 'POST',
        body: miningRewardTransaction,
        json: true
      }
      return rp(requestOptions);
    })
    // .then from returned promise of Broadcast mining
    .then(data => {
      res.json({
        note: "Blocked mined and broadcast succesfully",
        block: newBlock
      });
    })
    .catch(err => console.log(err));

})

router.post("/register-and-broadcast-node", function(req, res) {
  const newNodeUrl = req.body.newNodeUrl;
  const reqNodesPromises = [];

  if (bitcoin.networkNodes.indexOf(newNodeUrl) == -1) {
    bitcoin.networkNodes.push(newNodeUrl);
    bitcoin.writeBlockchainFile(bitcoin.chain, bitcoin.pendingTransactions, bitcoin.networkNodes);
  }

  bitcoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/register-node',
      method: 'POST',
      body: { newNodeUrl: newNodeUrl },
      json: true
    };
    reqNodesPromises.push(rp(requestOptions));
  })

    Promise.all(reqNodesPromises)
      .then(data => {
        const bulkRegisterOptions = {
          uri: newNodeUrl + '/register-nodes-bulk',
          method: 'POST',
          body: { allNetworkNodes: [...bitcoin.networkNodes, bitcoin.currentNodeUrl] },
          json: true
        }
        return rp(bulkRegisterOptions);
      })
      .then(data => {
        res.json({
          note: 'New node registered with network',
          node: newNodeUrl
        });
      })
      .catch(err => console.log(err))

})

router.post('/register-node', function(req, res) {
  const newNodeUrl = req.body.newNodeUrl;
  if (bitcoin.networkNodes.indexOf(newNodeUrl) == -1 && bitcoin.currentNodeUrl !== newNodeUrl) {
    bitcoin.networkNodes.push(newNodeUrl);
    bitcoin.writeBlockchainFile(bitcoin.chain, bitcoin.pendingTransactions, bitcoin.networkNodes);
    res.json({
      note: 'New node registered',
      node: newNodeUrl
    })
  }else {
    res.json({
      note: 'Node already registered',
      node: newNodeUrl
    })
  }
})

router.post('/register-nodes-bulk', function(req, res) {
  const allNetworkNodes = req.body.allNetworkNodes;
  allNetworkNodes.forEach(networkNodeUrl => {
    if (bitcoin.networkNodes.indexOf(networkNodeUrl) == -1 && networkNodeUrl !== bitcoin.currentNodeUrl) {
      bitcoin.networkNodes.push(networkNodeUrl);
      bitcoin.writeBlockchainFile(bitcoin.chain, bitcoin.pendingTransactions, bitcoin.networkNodes);
    }
  })

  res.json({
    note: "Bulk registration completed succesfully"
  });

})

router.post('/receive-new-block', function(req, res) {
  const newBlock = req.body.newBlock;
  // Check if block valid
  lastBlock = bitcoin.getLastBlock();
  const correctHash = lastBlock.hash === newBlock.previousHash;
  const correctIndex = lastBlock.index + 1 == newBlock.index;

  if (correctHash && correctIndex) {
    bitcoin.chain.push(newBlock);
    bitcoin.pendingTransactions = [];
    bitcoin.writeBlockchainFile(bitcoin.chain, bitcoin.pendingTransactions, bitcoin.networkNodes);
    res.json({
      note: 'New block received and accepted',
      newBlock: newBlock
    });
  }else {
    res.json({
      note: 'Block rejected',
      newBlock: newBlock
    });
  }
})

router.get('/consensus', function(req, res) {
  // Getting the blockchain of each node in the network
  const reqNodesPromises = [];
  bitcoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/blockchain',
      method: 'GET',
      json: true
    };
    reqNodesPromises.push(rp(requestOptions));
     Promise.all(reqNodesPromises)
      .then(blockchains => {
        const currentChainLength = bitcoin.chain.length;
        let currentChainReplaced = false;

        blockchains.forEach(blockchain => {
          let nodeChainLength = blockchain.chain.length;
          // Replacing current chain with longer chain from node
          if (nodeChainLength > currentChainLength) {
            // Replace only if chain is valid
            if (bitcoin.chainIsValid(blockchain.chain)) {
              bitcoin.chain = blockchain.chain;
              bitcoin.pendingTransactions = blockchain.pendingTransactions;
              currentChainReplaced = true;
            }            
          }
        })

        if (currentChainReplaced) {
          res.json({
            note: 'Current chain has been replaced',
            chain: bitcoin.chain
          });
        }else {
          res.json({
            note: 'Current chain has not been replaced',
            chain: bitcoin.chain
          });
        }
      })
      .catch(err => console.log(err));
  })
})

router.get('/block/:blockHash', function(req, res) {
  const block = bitcoin.getBlock(req.params.blockHash);
  if (block !== null) {
    res.json({
      note: 'Block found',
      block: block
    });
  }else {
    res.json({
      note: 'Block not found',
      blockHash: req.params.blockHash
    });
  }
  
})

router.get('/transaction/:transactionId', function(req, res) {
  const transaction = bitcoin.getTransactionById(req.params.transactionId);
  if (transaction !== null) {
    res.json({
      note: 'Transaction found',
      transaction: transaction
    });
  }else {
    res.json({
      note: 'Transaction not found',
      transactionId: req.params.transactionId
    });
  }
  
})

router.get('/address/:address', function(req, res) {
  const addressTransactions = bitcoin.getTransactionsByAddress(req.params.address);
  let balance = 0;
  // Calculate balance
  addressTransactions.forEach(transaction => {
    if (transaction.sender === req.params.address) {
      balance -= transaction.amount;
    }
    if (transaction.recipient === req.params.address) {
      balance += transaction.amount;
    }
  })
  res.json({
    balance: balance,
    transactions: addressTransactions
  });

})

module.exports = {
  path: '/api',
  handler: router
}
 
// app.listen(port, function() {
//   console.log("Listening on port " + port + " ....");
// })