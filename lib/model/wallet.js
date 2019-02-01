'use strict';

var _ = require('lodash');
var util = require('util');
var log = require('npmlog');
var $ = require('preconditions').singleton();
var Uuid = require('uuid');

var Address = require('./address');
var Copayer = require('./copayer');
var AddressManager = require('./addressmanager');

var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

function Wallet() {};

Wallet.create = function(opts) {
  opts = opts || {};

  var x = new Wallet();

  $.shouldBeNumber(opts.m);
  $.shouldBeNumber(opts.n);
  $.checkArgument(Utils.checkValueInCollection(opts.coin, Constants.COINS));
  $.checkArgument(Utils.checkValueInCollection(opts.network, Constants.NETWORKS));

  x.version = '1.0.0';
  x.createdOn = Math.floor(Date.now() / 1000);
  x.id = opts.id || Uuid.v4();
  x.name = opts.name;
  x.m = opts.m;
  x.n = opts.n;
  x.singleAddress = !!opts.singleAddress;
  x.status = 'pending';
  x.publicKeyRing = [];
  x.addressIndex = 0;
  x.copayers = [];
  x.pubKey = opts.pubKey;
  x.coin = opts.coin;
  x.network = opts.network;
  x.derivationStrategy = opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP45;
  x.addressType = opts.addressType || Constants.SCRIPT_TYPES.P2SH;

  x.addressManager = AddressManager.create({
    derivationStrategy: x.derivationStrategy,
  });
  x.scanStatus = null;

  return x;
};

Wallet.fromObj = function(obj) {
  var x = new Wallet();

  $.shouldBeNumber(obj.m);
  $.shouldBeNumber(obj.n);

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.id = obj.id;
  x.name = obj.name;
  x.m = obj.m;
  x.n = obj.n;
  x.singleAddress = !!obj.singleAddress;
  x.status = obj.status;
  x.publicKeyRing = obj.publicKeyRing;
  x.copayers = _.map(obj.copayers, function(copayer) {
    return Copayer.fromObj(copayer);
  });
  x.pubKey = obj.pubKey;
  x.coin = obj.coin || Defaults.COIN;
  x.network = obj.network;
  x.derivationStrategy = obj.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP45;
  x.addressType = obj.addressType || Constants.SCRIPT_TYPES.P2SH;
  x.addressManager = AddressManager.fromObj(obj.addressManager);
  x.scanStatus = obj.scanStatus;

  return x;
};

Wallet.prototype.toObject = function() {
  var x = _.cloneDeep(this);
  x.isShared = this.isShared();
  return x;
};

/**
 * Get the maximum allowed number of required copayers.
 * This is a limit imposed by the maximum allowed size of the scriptSig.
 * @param {number} totalCopayers - the total number of copayers
 * @return {number}
 */
Wallet.getMaxRequiredCopayers = function(totalCopayers) {
  return Wallet.COPAYER_PAIR_LIMITS[totalCopayers];
};

Wallet.verifyCopayerLimits = function(m, n) {
  return (n >= 1 && n <= 15) && (m >= 1 && m <= n);
};

Wallet.prototype.isShared = function() {
  return this.n > 1;
};


Wallet.prototype._updatePublicKeyRing = function() {
  this.publicKeyRing = _.map(this.copayers, function(copayer) {
    return _.pick(copayer, ['xPubKey', 'requestPubKey']);
  });
};

Wallet.prototype.addCopayer = function(copayer) {
  $.checkState(copayer.coin == this.coin);

  this.copayers.push(copayer);
  if (this.copayers.length < this.n) return;

  this.status = 'complete';
  this._updatePublicKeyRing();
};

Wallet.prototype.addCopayerRequestKey = function(copayerId, requestPubKey, signature, restrictions, name) {
  $.checkState(this.copayers.length == this.n);

  var c = this.getCopayer(copayerId);

  //new ones go first
  c.requestPubKeys.unshift({
    key: requestPubKey.toString(),
    signature: signature,
    selfSigned: true,
    restrictions: restrictions || {},
    name: name || null,
  });
};

Wallet.prototype.getCopayer = function(copayerId) {
  return _.find(this.copayers, {
    id: copayerId
  });
};

Wallet.prototype.isComplete = function() {
  return this.status == 'complete';
};

Wallet.prototype.isScanning = function() {
  return this.scanning;
};

Wallet.prototype.createAddress = function(isChange, sha256) {
  $.checkState(this.isComplete());

  var self = this;

  var path = this.addressManager.getNewAddressPath(isChange);
  log.verbose('Deriving addr:' + path);
  var address = Address.derive(self.id, this.addressType, this.publicKeyRing, path, this.m, this.coin, this.network, isChange, sha256);
  return address;
};

Wallet.prototype.createAddresses = function(isChange) {
  $.checkState(this.isComplete());

  var self = this,
      addresses = [];

  var path = this.addressManager.getNewAddressPath(isChange);
  log.verbose('Deriving addr:' + path);

  addresses.push(Address.derive(self.id, this.addressType, this.publicKeyRing, path, this.m, this.coin, this.network, isChange));

  if (self.coin === 'part')
    addresses.push(Address.derive(self.id, this.addressType, this.publicKeyRing, path, this.m, this.coin, this.network, isChange, true));

  return addresses;
};

Wallet.prototype.createColdStakingAddress = function(xpubOrBech32) {
  $.checkState(this.isComplete());

  if(!xpubOrBech32)
    return null;

  var self = this,
      validAddressPrefixes = {
        livenet: ['pcs', 'PPAR'],
        testnet: ['tpcs', 'ppar']
      },
      addressPrefixes = validAddressPrefixes[this.network],
      isValid = false,
      isBech32 = false;

  for (var i = 0; i < addressPrefixes.length; i++) {
    if (xpubOrBech32.startsWith(addressPrefixes[i])) {
      isValid = true;
      isBech32 = addressPrefixes[i].toLowerCase() !== 'ppar';

      break;
    }
  }

  $.checkState(isValid);

  // Haxx for now
  if (isBech32) {
    // TODO: Extra validations that its a valid bech32 address
    return xpubOrBech32;
  }

  var path = this.addressManager.getNewColdStakingAddressPath();
  log.verbose('Deriving addr:' + path);
  var address = Address.derive(self.id, this.addressType, [{xPubKey: xpubOrBech32}], path, this.m, this.coin, this.network, false, false, true);

  return address.address;
};


module.exports = Wallet;
