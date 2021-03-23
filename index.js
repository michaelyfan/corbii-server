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
 * Collection deletion method taken from https://firebase.google.com/docs/firestore/manage-data/delete-data#node.js_2
 * Modified so that collection both collection references and queries
 */
async function deleteCollection(collectionReferenceOrQuery, batchSize=100) {
  const query = collectionReferenceOrQuery.orderBy('__name__').limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve).catch(reject);
  });
}

/**
 * Collection deletion helper method taken from https://firebase.google.com/docs/firestore/manage-data/delete-data#node.js_2
 */
async function deleteQueryBatch(query, resolve) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    // When there are no documents left, we are done
    resolve();
    return;
  }

  // Delete documents in a batch
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // Recurse on the next process tick, to avoid
  // exploding the stack.
  process.nextTick(() => {
    deleteQueryBatch(db, query, resolve);
  });
}

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

  const cardDataRef = db.collection('spacedRepData').where('cardId', '==', cardId);
  deleteCollection(cardDataRef).catch((e) => {
    console.log('Error in /deleteCardSpacedRepData:', e);
  });
  res.sendStatus(202);
})

app.post('/deleteDeckSpacedRepData/:deckId', async (req, res) => {
  const idToken = req.get('Authorization') ? req.get('Authorization').trim().split('Bearer ')[1] : null;
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.sendStatus(401);
    return;
  }

  const deckId = req.params.deckId;
  if (!deckId) {
    res.status(400).send('Please provide a deckId.');
  }

  const cardDataRef = db.collection('spacedRepData').where('deckId', '==', deckId);
  deleteCollection(cardDataRef).catch((e) => {
    console.log('Error in /deleteDeckSpacedRepData:', e);
  });
  res.sendStatus(202);
})

app.post('/deleteDeckSubcollections/:deckId', async (req, res) => {
  // const idToken = req.get('Authorization') ? req.get('Authorization').trim().split('Bearer ')[1] : null;
  // try {
  //   await admin.auth().verifyIdToken(idToken);
  // } catch (err) {
  //   res.sendStatus(401);
  //   return;
  // }

  const deckId = req.params.deckId;
  if (!deckId) {
    res.status(400).send('Please provide a deckId.');
  }

  const cardsRef = db.collection('decks').doc(deckId).collection('cards');
  deleteCollection(cardsRef).catch((e) => { 
    console.log('Error in /deleteDeckSubcollections: ', e);
  });
  res.sendStatus(202);
})

app.listen(port, () => {
  console.log(`Corbii server is listening on port ${port}.`)
})