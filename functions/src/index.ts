// import {onRequest} from "firebase-functions/v2/https";
// import * as logger from "firebase-functions/logger";

import * as functions from "firebase-functions";
import {ethers} from "ethers";
import admin from "firebase-admin";
import {Timestamp} from "firebase-admin/firestore";
import dotenv from "dotenv";
import ContestOracleResolvedABI from "./ContestOracleResolved.json";
import CFPv1ABI from "./CFPv1.json";

dotenv.config();
admin.initializeApp();
const db = admin.firestore();

const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const contestContractAddress = process.env.CONTESTORACLERESOLVED_ADDRESS;
const contestContract = new ethers.Contract(
  contestContractAddress!, ContestOracleResolvedABI, provider
);
const speculationContractAddress = process.env.CFP_ADDRESS;
const speculationContract = new ethers.Contract(
  speculationContractAddress!, CFPv1ABI, provider
);

export const listenForContestCreation = functions.pubsub.schedule(
  "every 1 minutes"
).onRun(async (context) => {
  // eslint-disable-next-line new-cap
  const eventFilter = contestContract.filters.ContestCreated();
  const fromBlock = parseInt(process.env.CONTESTORACLERESOLVED_LATEST || "0");
  const events = await contestContract.queryFilter(eventFilter, fromBlock);

  for (const event of events) {
    try {
      // Type assertion to access the args property
      const eventData = (event as any).args;
      const contestIdStr = eventData.contestId.toString();
      if (eventData) {
        const contestsRef = db.collection("contests");
        const querySnapshot = await contestsRef.where(
          "jsonoddsID", "==", eventData.jsonoddsId).get();

        if (!querySnapshot.empty) {
          querySnapshot.forEach(async (doc) => {
            await doc.ref.update({
              Created: true,
              contestId: contestIdStr,
              status: "Created",
            });
            console.log(`Contest with JsonOddsID ${eventData.jsonoddsId} 
            marked as created, contestId set to ${contestIdStr}`);
          });
        } else {
          console.log(`Contest with JsonOddsID ${eventData.jsonoddsId} 
          does not exist in Firestore. Skipping.`);
        }
      }
    } catch (error) {
      console.error("Error listening for contest creation:", error);
    }
  }
});

export const listenForSpeculationCreation = functions.pubsub.schedule(
  "every 1 minutes"
).onRun(async (context) => {
  // eslint-disable-next-line new-cap
  const eventFilter = speculationContract.filters.SpeculationCreated();
  const fromBlock = parseInt(process.env.CFP_LATEST || "0");
  const events = await speculationContract
    .queryFilter(eventFilter, fromBlock);

  for (const event of events) {
    try {
      // Type assertion to access the args property
      const eventData = (event as any).args;
      const {
        lockTime,
        speculationScorer,
        speculationCreator} = eventData;
      const speculationIdStr = eventData.speculationId.toString();
      const contestIdStr = eventData.contestId.toString();
      const theNumberInt = Number(eventData.theNumber);
      const lockTimeDate = admin.firestore.Timestamp
        .fromDate(new Date(Number(lockTime) * 1000));
      // Skip speculations that occur in the past
      if (lockTimeDate <= Timestamp.now()) {
        console.log(`Speculation ${speculationIdStr}
          occurs in the past and will not be added.`);
        continue;
      }
      const speculationIdentifier =
        `${contestIdStr}-${speculationScorer.toLowerCase()}`;
      const speculationRef = db.collection("speculations")
        .doc(speculationIdentifier);
      await speculationRef.update({
        speculationId: speculationIdStr,
        contestId: contestIdStr,
        lockTime: lockTimeDate,
        speculationScorer: speculationScorer.toLowerCase(),
        theNumber: theNumberInt,
        speculationCreator: speculationCreator,
        status: "Created",
      });
      console.log(`Speculation ${speculationIdStr} 
        for contest ${contestIdStr} added to Firestore.`);
    } catch (error) {
      console.error("Error listening for speculation creation:", error);
    }
  }
});

export const scheduledFirestoreCleanup =
  functions.pubsub.schedule("every 24 hours").onRun(async (context) => {
    const now = Timestamp.now();
    // Archive contests
    const contestsQuerySnapshot = await db.collection("contests")
      .where("MatchTime", "<=", now).get();
    const contestsArchiveBatch = db.batch();
    contestsQuerySnapshot.forEach((doc) => {
      const archiveRef = db.collection("contests_archive").doc(doc.id);
      contestsArchiveBatch.set(archiveRef,
        {...doc.data(), archivedDate: now});
      contestsArchiveBatch.delete(doc.ref);
    });

    // Archive speculations
    const speculationsQuerySnapshot = await db.collection("speculations")
      .where("lockTime", "<=", now).get();
    const speculationsArchiveBatch = db.batch();
    speculationsQuerySnapshot.forEach((doc) => {
      const archiveRef = db.collection("speculations_archive").doc(doc.id);
      speculationsArchiveBatch.set(archiveRef,
        {...doc.data(), archivedDate: now});
      speculationsArchiveBatch.delete(doc.ref);
    });

    try {
      // Committing both batches
      await contestsArchiveBatch.commit();
      console.log("Successfully archived contests.");
      await speculationsArchiveBatch.commit();
      console.log("Successfully archived speculations.");
    } catch (error) {
      console.error("Error during Firestore cleanup:", error);
    }
  });
