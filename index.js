require('dotenv').config({ silent: true });

const _ = require('lodash');
const fs = require('mz/fs');
const logger = require('winston');
const moment = require('moment');
const pogobuf = require('pogobuf-vnext');
const POGOProtos = require('node-pogo-protos');

const RequestType = POGOProtos.Networking.Requests.RequestType;
const PlatformRequestType = POGOProtos.Networking.Platform.PlatformRequestType;

let config = {
    api: {
        version: 6301,
        country: 'FR',
        language: 'fr',
        timezone: 'Europe/Paris',
    },
    loglevel: 'debug',
};
async function loadConfig() {
    if (!fs.existsSync('config.json')) throw new Error('Please create a config.json config file.');

    const content = await fs.readFile('config.json', 'utf8');
    config = _.defaultsDeep(JSON.parse(content), config);

    logger.remove(logger.transports.Console);
    logger.add(logger.transports.Console, {
        'timestamp': function() {
            return moment().format('HH:mm:ss');
        },
        'colorize': true,
        'level': config.loglevel,
    });

    logger.add(logger.transports.File, {
        'timestamp': function() {
            return moment().format('HH:mm:ss');
        },
        'filename': 'node-check-account.log',
        'json': false,
        'level': config.loglevel,
    });
}

async function loadAccount(filename, delimiter = ',') {
    if (!fs.existsSync(filename)) throw new Error('accounts.csv does not exist.');

    const content = await fs.readFile(filename, 'utf8');
    const lines = content.split(/\r?\n/);
    const accounts = [];
    for (const line of lines) {
        const account = line.split(delimiter);
        accounts.push({
            type: account[0],
            username: account[1],
            password: account[2],
        });
    }
    return accounts;
}

async function loginFlow(account, client) {
    client.setPosition({
        latitude: config.position.latitude,
        longitude: config.position.longitude,
        altitude: _.random(-10, 20, true),
    });

    await client.init(false);

    await client.batchStart().batchCall();

    let batch = client.batchStart();
    batch.getPlayer(config.api.country, config.api.language, config.api.timezone);
    let response = await client.batchCall();

    account.warn = response.warn;
    account.banned = response.banned;

    logger.info(`  acount is ${account.warn ? '' : 'not '}warn`);
    logger.info(`  acount is ${account.banned ? '' : 'not '}banned`);

    batch = client.batchStart();
    batch.downloadRemoteConfigVersion(POGOProtos.Enums.Platform.IOS, '', '', '', +config.api.version)
         .checkChallenge()
         .getHatchedEggs()
         .getInventory(0)
         .checkAwardedBadges()
         .downloadSettings('');
    response = await batch.batchCall();

    const inventoryResponse = _.find(response, resp => resp._requestType === RequestType.GET_INVENTORY);
    const level = pogobuf.Utils.splitInventory(inventoryResponse).player.level;
    const inventory = inventoryResponse.inventory_delta.new_timestamp_ms;

    const settings = _.find(response, resp => resp._requestType === RequestType.DOWNLOAD_SETTINGS).hash;

    batch = client.batchStart();
    batch.getPlayerProfile('')
         .checkChallenge()
         .getHatchedEggs()
         .getInventory(inventory)
         .checkAwardedBadges()
         .downloadSettings(settings)
         .getBuddyWalked();
    await batch.batchCall();

    batch = client.batchStart();
    batch.levelUpRewards(level)
         .checkChallenge()
         .getHatchedEggs()
         .getInventory(inventory)
         .checkAwardedBadges()
         .downloadSettings(settings)
         .getBuddyWalked();
    await batch.batchCall();

    return {
        inventory: inventory,
        settings: settings,
    };
}

async function checkAccount(account) {
    logger.info('Checking account ' + account.username);

    const deviceId = _.times(32, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const client = new pogobuf.Client({
        deviceId: deviceId,
        authType: account.type,
        username: account.username,
        password: account.password,
        version: config.api.version,
        useHashingServer: true,
        hashingKey: config.hashkey,
        includeRequestTypeInResponse: true,
        proxy: config.proxy,
        maxTries: 1,
    });

    await loginFlow(account, client);

    try {
        const batch = client.batchStart();
        batch.batchAddPlatformRequest(PlatformRequestType.GET_STORE_ITEMS,
                                      new POGOProtos.Networking.Platform.Requests.GetStoreItemsRequest({}));
        const response = await batch.batchCall();

        await fs.writeFile('store.json', JSON.stringify(response, null, 4), 'utf8');

        account.store = true;
        account.iap = _.some(response.items, item => item.is_iap);
    } catch (e) {
        account.store = false;
        account.iap = false;
    }

    logger.info(`  acount has ${account.store ? '' : 'not '}access to the store.`);
}

async function saveToFile(accounts, filename) {
    let content = 'username,banned,warn,store,iap\n';
    for (const account of accounts) {
        content += `${account.username},${account.banned},${account.warn},${account.store},${account.iap}\n`;
    }
    await fs.writeFile(filename, content, 'utf8');
}

async function Main() {
    await loadConfig();
    const accounts = await loadAccount('accounts.4.csv');
    for (const account of accounts) {
        await checkAccount(account);
    }
    await saveToFile(accounts, 'output.csv');
}

Main()
.then(() => logger.info('Done'))
.catch(e => logger.error(e));
