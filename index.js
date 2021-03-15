if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}

const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // handle private key newline characters
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
  })
});
const db = admin.firestore();
const refreshCollectionName = 'refresh';
const refreshDocName = 'searchIndex';
const refreshKeyName = 'lastSyncTime';

const algoliasearch = require('algoliasearch');
const algoliaClient = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_API_KEY);

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

var { DateTime } = require('luxon');

/**
 * Attempts search index sync. Returns void. You shouldn't wait for this to finish running anyway, since it can take a while.
 */
async function runSearchIndexSync() {
  // get all users, index all using Firestore UUID as Algolia objectID
  const users = await db.collection('users').get();
  const usersIndexObjects = users.docs.map((queryDocSnap) => {
    const docData = queryDocSnap.data();
    docData.objectID = queryDocSnap.id;
    return docData;
  });
  algoliaClient.initIndex('users').saveObjects(usersIndexObjects);

  // do the above but with decks
  const decks = await db.collection('decks').get();
  const decksIndexObjects = decks.docs.map((queryDocSnap) => {
    const docData = queryDocSnap.data();
    docData.objectID = queryDocSnap.id;
    return docData;
  });
  algoliaClient.initIndex('decks').saveObjects(decksIndexObjects);
}

app.get('/', (req, res) => {
  res.send('Corbii server is up.')
})

app.post('/syncSearchIndexes', async (req, res) => {
  const idToken = req.get('Authorization') ? req.get('Authorization').trim().split('Bearer ')[1] : null;
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.sendStatus(401);
    return;
  }

  try {
    res.sendStatus(202);
    const timeDoc = await db.collection(refreshCollectionName).doc(refreshDocName).get();
    // run search index sync if it has been 24 hours since last sync
    // also runs the sync if the database tracker for the last sync doesn't exist
    if (!timeDoc.exists
      || !(timeDoc.data()[refreshKeyName])
      || DateTime.fromJSDate(timeDoc.data()[refreshKeyName].toDate()).plus({ hours: 24 }) < DateTime.now()) {
      // place new sync date
      db.collection(refreshCollectionName).doc(refreshDocName).set({ [refreshKeyName]: new Date() });

      // get all users, index all using Firestore UUID as Algolia objectID
      const users = await db.collection('users').get();
      const usersIndexObjects = users.docs.map((queryDocSnap) => {
        const docData = queryDocSnap.data();
        docData.objectID = queryDocSnap.id;
        return docData;
      });
      
      // do the above but with decks
      const decks = await db.collection('decks').get();
      const decksIndexObjects = decks.docs.map((queryDocSnap) => {
        const docData = queryDocSnap.data();
        docData.objectID = queryDocSnap.id;
        return docData;
      });
      await Promise.all([
        algoliaClient.initIndex('users').saveObjects(usersIndexObjects),
        algoliaClient.initIndex('decks').saveObjects(decksIndexObjects)
      ]);
    }
  } catch (err) {
    console.log(`Error in /syncSearchIndexes: ${err}`);
  }
})

app.post('/deleteCardSpacedRepData/:cardId', async (req, res) => {
  const idToken = req.get('Authorization') ? req.get('Authorization').trim().split('Bearer ')[1] : null;
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.sendStatus(401);
    return;
  }

  const cardId = req.params.cardId;
  if (!cardId) {
    res.status(400).send('Please provide a cardId.');
  }

  try {
    const cardDataRef = db.collection('spacedRepData').where('cardId', '==', cardId);
    cardDataRef.get().then((querySnap) => {
      querySnap.docs.forEach((queryDocSnap) => {
        queryDocSnap.ref.delete().catch((err) => { console.log(`Error deleting card spaced rep data, data ID ${queryDocSnap.id}`) });
      });
    })
    res.sendStatus(202);
  } catch (e) {
    console.log(`Error in /deleteCardSpacedRepData: ${e}`);
    res.sendStatus(500);
  }
})

app.listen(port, () => {
  console.log(`Corbii server is listening on port ${port}.`)
})