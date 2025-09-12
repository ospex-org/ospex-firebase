import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { AbiCoder } from "ethers";
admin.initializeApp();

const { Timestamp, FieldValue } = admin.firestore;

const db = admin.firestore();

// Event Handler Registry - Add new events here as they're implemented
interface EventHandler {
  eventName: string;
  eventHash: string;
  dataSchema: string[]; // ABI types for decoding
  handler: (decodedData: any[], eventData: any) => Promise<void>;
}

const EVENT_HANDLERS: EventHandler[] = [
  {
    eventName: "CONTEST_CREATED",
    eventHash: "0x8b7310c24026089e2276294322070f3559697dbd233850442c46698089d2212a",
    dataSchema: ["uint256", "string", "string", "string", "address", "bytes32"],
    handler: async (decodedData, eventData) => {
      const [contestId, rundownId, sportspageId, jsonoddsId, contestCreator, scoreContestSourceHash] = decodedData;
      console.log("CONTEST_CREATED:", { contestId: contestId.toString(), rundownId, sportspageId, jsonoddsId });

      // Look up contest by jsonoddsID in amoyContestsv2.3
      const amoyContestsRef = db.collection("amoyContestsv2.3");
      const querySnapshot = await amoyContestsRef.where("jsonoddsID", "==", jsonoddsId.toString()).get();
      if (!querySnapshot.empty) {
        console.log(`Contest with jsonoddsID ${jsonoddsId.toString()} already exists in amoyContestsv2.3, skipping.`);
      } else {
        // Copy from contests collection
        const contestsRef = db.collection("contests");
        const contestsSnapshot = await contestsRef.where("jsonoddsID", "==", jsonoddsId.toString()).get();
        if (!contestsSnapshot.empty) {
          for (const doc of contestsSnapshot.docs) {
            const data = doc.data();
            const { Created, ...rest } = data;
            await amoyContestsRef.doc(contestId.toString()).set({
              ...rest,
              contestId: contestId.toString(),
              contestCreator: contestCreator.toLowerCase(),
              scoreContestSourceHash: scoreContestSourceHash,
              status: 'Unverified',
            });
            console.log(`Copied contest ${contestId.toString()} to amoyContestsv2.3 from contests with status 'Unverified'.`);
          }
        } else {
          console.error(`ERROR: Contest with jsonoddsID ${jsonoddsId.toString()} not found in contests collection.`);
        }
      }
    }
  },
  {
    eventName: "CONTEST_VERIFIED",
    eventHash: "0x02cbb0ceffdfccf943861853e3813e29364ccff7b8d2006c7551ce8b933a5fa1",
    dataSchema: ["uint256", "uint256"],
    handler: async (decodedData, eventData) => {
      const [contestId, startTime] = decodedData;
      console.log("[CONTEST_VERIFIED] contestId:", contestId.toString(), "startTime:", startTime.toString());

      const amoyContestsRef = db.collection("amoyContestsv2.3");
      const contestDoc = amoyContestsRef.doc(contestId.toString());
      const docSnapshot = await contestDoc.get();
      if (docSnapshot.exists) {
        await contestDoc.update({
          status: 'Verified',
          startTime: startTime.toString(),
        });
        console.log(`Updated contest ${contestId.toString()} status to 'Verified' in amoyContestsv2.3.`);
      } else {
        console.log(`No contest found in amoyContestsv2.3 for contestId ${contestId.toString()}, skipping verification update.`);
      }
    }
  },
  {
    eventName: "CONTEST_MARKETS_UPDATED",
    eventHash: "0xe8330a188b17773dfe2bce7fc47f33eef36d3ff516cf68ec5e5b51f508131631",
    dataSchema: ["uint256", "uint32", "int32", "int32", "uint64", "uint64", "uint64", "uint64", "uint64", "uint64"],
    handler: async (decodedData, eventData) => {
      const [contestId, timestamp, spreadNumber, totalNumber, moneylineAwayOdds, moneylineHomeOdds, spreadAwayOdds, spreadHomeOdds, overOdds, underOdds] = decodedData;
      console.log("CONTEST_MARKETS_UPDATED:", { 
        contestId: contestId.toString(), 
        timestamp: timestamp.toString(),
        spreadNumber: spreadNumber.toString(),
        totalNumber: totalNumber.toString(),
        moneylineAwayOdds: moneylineAwayOdds.toString(),
        moneylineHomeOdds: moneylineHomeOdds.toString(),
        spreadAwayOdds: spreadAwayOdds.toString(),
        spreadHomeOdds: spreadHomeOdds.toString(),
        overOdds: overOdds.toString(),
        underOdds: underOdds.toString()
      });

      // Update contest in amoyContestsv2.3 collection with on-chain odds
      const amoyContestsRef = db.collection("amoyContestsv2.3");
      const contestDoc = amoyContestsRef.doc(contestId.toString());
      const docSnapshot = await contestDoc.get();
      
      if (docSnapshot.exists) {
        // Convert odds from contract format (e.g., 11500000) to display format (e.g., "+115")
        const formatOdds = (odds: any): string => {
          const oddsNum = parseInt(odds.toString());
          const decimalOdds = oddsNum / 10000000; // Convert from 1e7 precision
          if (decimalOdds >= 2.0) {
            // Positive American odds: (decimal - 1) * 100
            return `+${Math.round((decimalOdds - 1) * 100)}`;
          } else {
            // Negative American odds: -100 / (decimal - 1)
            return `${Math.round(-100 / (decimalOdds - 1))}`;
          }
        };

        // Format spread number (contract uses int32, convert to string with sign)
        // Contract stores in increments of 10 (e.g., 15 = 1.5, -25 = -2.5)
        const spreadNum = parseInt(spreadNumber.toString());
        const awaySpread = spreadNum > 0 ? `+${spreadNum / 10}` : `${spreadNum / 10}`;
        const homeSpread = spreadNum > 0 ? `-${spreadNum / 10}` : `+${Math.abs(spreadNum) / 10}`;

        // Format total number (contract stores in increments of 10, e.g., 95 = 9.5)
        const totalNum = (parseInt(totalNumber.toString()) / 10).toString();

        await contestDoc.update({
          // Update with on-chain odds (overwrite starter odds)
          MoneyLineAway: formatOdds(moneylineAwayOdds),
          MoneyLineHome: formatOdds(moneylineHomeOdds),
          PointSpreadAway: awaySpread,
          PointSpreadHome: homeSpread,
          PointSpreadAwayLine: formatOdds(spreadAwayOdds),
          PointSpreadHomeLine: formatOdds(spreadHomeOdds),
          TotalNumber: totalNum,
          OverLine: formatOdds(overOdds),
          UnderLine: formatOdds(underOdds),
          
          // Add new field to track on-chain odds updates
          onChainOddsLastUpdated: Timestamp.fromDate(new Date(parseInt(timestamp.toString()) * 1000)),
          
          // Keep original LastUpdated for starter odds reference  
          updatedAt: Timestamp.now(),
        });
        
        console.log(`Updated contest ${contestId.toString()} with on-chain odds from oracle`);
      } else {
        console.log(`No contest found in amoyContestsv2.3 for contestId ${contestId.toString()}, skipping market update.`);
      }
    }
  },
  {
    eventName: "SPECULATION_CREATED",
    eventHash: "0x2f8c9d74e5c685587d29d55b2199da566ef57c9ecb168f3a0d0cf02733475a1f",
    dataSchema: ["uint256", "uint256", "address", "int32", "address"],
    handler: async (decodedData, eventData) => {
      const [speculationId, contestId, scorer, theNumber, speculationCreator] = decodedData;
      console.log("SPECULATION_CREATED:", { 
        speculationId: speculationId.toString(), 
        contestId: contestId.toString(), 
        scorer, 
        theNumber: theNumber.toString(),
        speculationCreator
      });

      // Store speculation in amoySpeculationsv2.3 collection
      const amoySpeculationsRef = db.collection("amoySpeculationsv2.3");
      
      // Check if speculation ID already exists (blockchain-level duplicate)
      const speculationDoc = amoySpeculationsRef.doc(speculationId.toString());
      const docSnapshot = await speculationDoc.get();
      
      if (docSnapshot.exists) {
        console.log(`Speculation ${speculationId.toString()} already exists in amoySpeculationsv2.3, skipping.`);
        return;
      }

      // Check for functional duplicates (same contest, scorer, and number)
      const duplicateQuery = await amoySpeculationsRef
        .where("contestId", "==", contestId.toString())
        .where("speculationScorer", "==", scorer.toLowerCase())
        .where("theNumber", "==", theNumber.toString())
        .limit(1)
        .get();

      if (!duplicateQuery.empty) {
        const existingSpeculation = duplicateQuery.docs[0];
        console.log(`Duplicate speculation detected! Skipping speculation ${speculationId.toString()}.`);
        console.log(`Existing speculation: ${existingSpeculation.id} with same contestId: ${contestId.toString()}, scorer: ${scorer}, theNumber: ${theNumber.toString()}`);
        return;
      }

      // Create new speculation document (no duplicates found)
      await speculationDoc.set({
        speculationId: speculationId.toString(),
        contestId: contestId.toString(),
        speculationCreator: speculationCreator.toLowerCase(),
        speculationScorer: scorer.toLowerCase(),
        theNumber: theNumber.toString(),
        speculationStatus: 0, // 0 = Open, 1 = Closed
        winSide: 0, // 0 = TBD
        createdAt: Timestamp.now(),
        // Note: startTimestamp is now stored on the contest, not the speculation
      });
      console.log(`Created unique speculation ${speculationId.toString()} in amoySpeculationsv2.3.`);
    }
  },
  {
    eventName: "CONTEST_SCORES_SET",
    eventHash: "0x637ab89ed933b7546cbd950d2e56492ddeaacfdd7dff7eb57b56eddd5a4f9bc1",
    dataSchema: ["uint256", "uint32", "uint32"],
    handler: async (decodedData, eventData) => {
      const [contestId, awayScore, homeScore] = decodedData;
      console.log("CONTEST_SCORES_SET:", { 
        contestId: contestId.toString(), 
        awayScore: awayScore.toString(), 
        homeScore: homeScore.toString() 
      });

      const amoyContestsRef = db.collection("amoyContestsv2.3");
      const contestDoc = amoyContestsRef.doc(contestId.toString());
      const docSnapshot = await contestDoc.get();
      
      if (docSnapshot.exists) {
        await contestDoc.update({
          status: 'Scored',
          awayScore: awayScore.toString(),
          homeScore: homeScore.toString(),
          scoredAt: Timestamp.now(),
        });
        console.log(`Updated contest ${contestId.toString()} with scores - Away: ${awayScore.toString()}, Home: ${homeScore.toString()}, status: 'Scored'`);
      } else {
        console.log(`No contest found in amoyContestsv2.3 for contestId ${contestId.toString()}, skipping score update.`);
      }
    }
  },
  {
    eventName: "SPECULATION_SETTLED",
    eventHash: "0xf5e6867f6725bf093b143d57dc9fe0b6c610b2553ba52461d0544c97d908d4f4",
    dataSchema: ["uint256", "uint8", "address"],
    handler: async (decodedData, eventData) => {
      const [speculationId, winner, scorer] = decodedData;
      console.log("SPECULATION_SETTLED:", { 
        speculationId: speculationId.toString(), 
        winner: winner.toString(),
        scorer: scorer.toLowerCase()
      });

      // Update speculation in amoySpeculationsv2.3 collection
      const amoySpeculationsRef = db.collection("amoySpeculationsv2.3");
      const speculationDoc = amoySpeculationsRef.doc(speculationId.toString());
      const docSnapshot = await speculationDoc.get();
      
      if (docSnapshot.exists) {
        await speculationDoc.update({
          speculationStatus: 1, // 1 = Closed
          winSide: winner, // WinSide enum value from the event
          settledAt: Timestamp.now(),
        });
        console.log(`Updated speculation ${speculationId.toString()} - Status: Closed, WinSide: ${winner.toString()}`);
      } else {
        console.log(`No speculation found in amoySpeculationsv2.3 for speculationId ${speculationId.toString()}, skipping settlement update.`);
      }
    }
  },
  {
    eventName: "POSITION_CREATED",
    eventHash: "0x8516611167c28bf928ba43c90eb7238b770f757c1131cb049dfe84f96c9f9ca4",
    dataSchema: ["uint256", "address", "uint128", "uint32", "uint8", "uint256", "uint64", "uint64"],
    handler: async (decodedData, eventData) => {
      const [speculationId, user, oddsPairId, unmatchedExpiry, positionType, amount, upperOdds, lowerOdds] = decodedData;
      console.log("POSITION_CREATED:", { 
        speculationId: speculationId.toString(), 
        user: user.toLowerCase(),
        oddsPairId: oddsPairId.toString(),
        unmatchedExpiry: unmatchedExpiry.toString(),
        positionType: positionType.toString(),
        amount: amount.toString(),
        upperOdds: upperOdds.toString(),
        lowerOdds: lowerOdds.toString()
      });

      // Store position in amoyPositionsv2.3 collection
      const amoyPositionsRef = db.collection("amoyPositionsv2.3");
      
      // Create unique document ID: speculationId_user_oddsPairId_positionType
      const docId = `${speculationId.toString()}_${user.toLowerCase()}_${oddsPairId.toString()}_${positionType.toString()}`;
      const positionDoc = amoyPositionsRef.doc(docId);
      
      // Check if position already exists
      const docSnapshot = await positionDoc.get();
      
      if (docSnapshot.exists) {
        console.log(`Position ${docId} already exists in amoyPositionsv2.3, updating with new data.`);
        // Update existing position (in case of adjustments)
        await positionDoc.update({
          unmatchedAmount: amount.toString(), // Initially all unmatched
          matchedAmount: "0",
          unmatchedExpiry: unmatchedExpiry.toString(),
          upperOdds: upperOdds.toString(),
          lowerOdds: lowerOdds.toString(),
          updatedAt: Timestamp.now(),
        });
        console.log(`Updated position ${docId} in amoyPositionsv2.3.`);
      } else {
        // Create new position document
        const positionTypeString = positionType.toString() === "0" ? "Upper" : "Lower";
        
        await positionDoc.set({
          speculationId: speculationId.toString(),
          user: user.toLowerCase(),
          oddsPairId: oddsPairId.toString(),
          positionType: positionType.toString(),
          positionTypeString: positionTypeString,
          matchedAmount: "0",
          unmatchedAmount: amount.toString(),
          unmatchedExpiry: unmatchedExpiry.toString(),
          upperOdds: upperOdds.toString(),
          lowerOdds: lowerOdds.toString(),
          claimed: false,
          createdAt: Timestamp.now(),
        });
        console.log(`Created position ${docId} in amoyPositionsv2.3.`);
      }
    }
  },
  {
    eventName: "POSITION_MATCHED",
    eventHash: "0x78090ba6e58711a2fb7123d0979a7618a576580e7ee98ec925208809aa9ea711",
    dataSchema: ["uint256", "address", "uint128", "uint8", "address", "uint256"],
    handler: async (decodedData, eventData) => {
      const [speculationId, maker, oddsPairId, makerPositionType, taker, amount] = decodedData;
      console.log("POSITION_MATCHED:", { 
        speculationId: speculationId.toString(), 
        maker: maker.toLowerCase(),
        oddsPairId: oddsPairId.toString(),
        makerPositionType: makerPositionType.toString(),
        taker: taker.toLowerCase(),
        amount: amount.toString()
      });

      const amoyPositionsRef = db.collection("amoyPositionsv2.3");
      
      // Get the maker's position to calculate how much gets matched
      const makerDocId = `${speculationId.toString()}_${maker.toLowerCase()}_${oddsPairId.toString()}_${makerPositionType.toString()}`;
      const makerDoc = amoyPositionsRef.doc(makerDocId);
      const makerSnapshot = await makerDoc.get();
      
      if (!makerSnapshot.exists) {
        console.error(`ERROR: Maker position ${makerDocId} not found in amoyPositionsv2.3.`);
        return;
      }

      const makerData = makerSnapshot.data();
      if (!makerData) {
        console.error(`ERROR: Maker position data is null for ${makerDocId}.`);
        return;
      }
      
      // Simple approach: Use stored odds from position creation (matches smart contract exactly)
      const ODDS_PRECISION = 10_000_000; // 1e7
      
      // Get stored upperOdds and lowerOdds from the maker's position
      const upperOdds = parseInt(makerData.upperOdds);
      const lowerOdds = parseInt(makerData.lowerOdds);
      
      // Calculate maker amount consumed using exact contract logic (matches Solidity)
      // From PositionModule.sol line 792-797:
      // uint256 makerAmountConsumed = (amount * (
      //     makerPos.positionType == PositionType.Upper
      //         ? oddsPair.lowerOdds - ODDS_PRECISION
      //         : oddsPair.upperOdds - ODDS_PRECISION
      // )) / ODDS_PRECISION;
      const makerPositionTypeNum = parseInt(makerPositionType.toString());
      const relevantOdds = makerPositionTypeNum === 0 ? lowerOdds : upperOdds; // Upper uses lowerOdds, Lower uses upperOdds
      const makerAmountConsumed = Math.floor((parseInt(amount.toString()) * (relevantOdds - ODDS_PRECISION)) / ODDS_PRECISION);
      
      console.log(`🔍 SIMPLE CONTRACT-MATCHING CALCULATION for oddsPairId=${oddsPairId}:`, {
        // Input values
        oddsPairId: oddsPairId.toString(),
        takerAmount: amount.toString(),
        takerAmountUSDC: parseInt(amount.toString()) / 1000000,
        makerPositionType: makerPositionType.toString(),
        maker: maker.toLowerCase(),
        taker: taker.toLowerCase(),
        // Stored odds (from position creation)
        upperOdds,
        lowerOdds,
        upperOddsDecimal: upperOdds / ODDS_PRECISION,
        lowerOddsDecimal: lowerOdds / ODDS_PRECISION,
        // Calculation
        relevantOdds,
        relevantOddsDecimal: relevantOdds / ODDS_PRECISION,
        // Final results
        makerAmountConsumed,
        makerAmountConsumedUSDC: makerAmountConsumed / 1000000,
        // Contract formula verification
        contractFormula: `${amount.toString()} * (${relevantOdds} - ${ODDS_PRECISION}) / ${ODDS_PRECISION} = ${makerAmountConsumed}`
      });
      
      // Update maker's position
      const newMakerMatchedAmount = (parseInt(makerData.matchedAmount) + parseInt(makerAmountConsumed.toString())).toString();
      const newMakerUnmatchedAmount = (parseInt(makerData.unmatchedAmount) - parseInt(makerAmountConsumed.toString())).toString();
      
      // Handle counterparty tracking with proper aggregation
      const currentCounterparties = makerData.counterparties || [];
      const currentCounterpartyAmounts = makerData.counterpartyAmounts || [];
      const takerLower = taker.toLowerCase();
      
      // Find if this taker already exists in counterparties
      const existingIndex = currentCounterparties.indexOf(takerLower);
      let newCounterparties = [...currentCounterparties];
      let newCounterpartyAmounts = [...currentCounterpartyAmounts];
      
      if (existingIndex >= 0) {
        // Taker already exists - add to their existing amount
        const existingAmount = parseInt(currentCounterpartyAmounts[existingIndex] || "0");
        const newAmount = existingAmount + parseInt(amount.toString());
        newCounterpartyAmounts[existingIndex] = newAmount.toString();
      } else {
        // New taker - add to end of arrays
        newCounterparties.push(takerLower);
        newCounterpartyAmounts.push(amount.toString());
      }
      
      await makerDoc.update({
        matchedAmount: newMakerMatchedAmount,
        unmatchedAmount: newMakerUnmatchedAmount,
        counterparties: newCounterparties,
        counterpartyAmounts: newCounterpartyAmounts,
        updatedAt: Timestamp.now(),
      });
      
      console.log(`🔍 MAKER POSITION UPDATE - ${makerDocId}:`, {
        previousMatched: makerData.matchedAmount,
        newMatchedAmount: newMakerMatchedAmount,
        previousUnmatched: makerData.unmatchedAmount,
        newUnmatchedAmount: newMakerUnmatchedAmount,
        makerAmountConsumed,
        addedTaker: taker.toLowerCase(),
        takerAmountAdded: amount.toString(),
        newCounterparties,
        newCounterpartyAmounts,
        totalCounterpartyAmountsSum: newCounterpartyAmounts.reduce((sum, amt) => sum + parseInt(amt), 0)
      });

      // Create taker position with opposite position type
      const takerPositionType = makerPositionType.toString() === "0" ? "1" : "0"; // Upper(0) -> Lower(1), Lower(1) -> Upper(0)
      const takerPositionTypeString = takerPositionType === "0" ? "Upper" : "Lower";
      
      const takerDocId = `${speculationId.toString()}_${taker.toLowerCase()}_${oddsPairId.toString()}_${takerPositionType}`;
      const takerDoc = amoyPositionsRef.doc(takerDocId);
      const takerSnapshot = await takerDoc.get();
      
      if (takerSnapshot.exists) {
        // Update existing taker position
        const takerData = takerSnapshot.data();
        if (!takerData) {
          console.error(`ERROR: Taker position data is null for ${takerDocId}.`);
          return;
        }
        const newTakerMatchedAmount = (parseInt(takerData.matchedAmount) + parseInt(amount.toString())).toString();
        
        // Handle counterparty tracking with proper aggregation for taker
        const currentTakerCounterparties = takerData.counterparties || [];
        const currentTakerCounterpartyAmounts = takerData.counterpartyAmounts || [];
        const makerLower = maker.toLowerCase();
        
        // Find if this maker already exists in taker's counterparties
        const existingMakerIndex = currentTakerCounterparties.indexOf(makerLower);
        let newTakerCounterparties = [...currentTakerCounterparties];
        let newTakerCounterpartyAmounts = [...currentTakerCounterpartyAmounts];
        
        if (existingMakerIndex >= 0) {
          // Maker already exists - add to their existing amount (use maker amount consumed - what the maker put up)
          const existingMakerAmount = parseInt(currentTakerCounterpartyAmounts[existingMakerIndex] || "0");
          const newMakerAmount = existingMakerAmount + parseInt(makerAmountConsumed.toString());
          newTakerCounterpartyAmounts[existingMakerIndex] = newMakerAmount.toString();
        } else {
          // New maker - add to end of arrays (use maker amount consumed - what the maker put up)
          newTakerCounterparties.push(makerLower);
          newTakerCounterpartyAmounts.push(makerAmountConsumed.toString());
        }
        
        await takerDoc.update({
          matchedAmount: newTakerMatchedAmount,
          counterparties: newTakerCounterparties,
          counterpartyAmounts: newTakerCounterpartyAmounts,
          // Copy odds from maker position (these are the same for both sides of the match)
          upperOdds: upperOdds.toString(),
          lowerOdds: lowerOdds.toString(),
          updatedAt: Timestamp.now(),
        });
        
        console.log(`🔍 TAKER POSITION UPDATE (existing) - ${takerDocId}:`, {
          previousMatched: takerData.matchedAmount,
          newTakerMatchedAmount,
          takerAmountAdded: amount.toString(),
          makerAmountConsumed,
          // Added odds from maker position
          upperOdds: upperOdds.toString(),
          lowerOdds: lowerOdds.toString(),
          newTakerCounterparties,
          newTakerCounterpartyAmounts,
          totalTakerCounterpartySum: newTakerCounterpartyAmounts.reduce((sum, amt) => sum + parseInt(amt), 0)
        });
      } else {
        // Create new taker position
        await takerDoc.set({
          speculationId: speculationId.toString(),
          user: taker.toLowerCase(),
          oddsPairId: oddsPairId.toString(),
          positionType: takerPositionType,
          positionTypeString: takerPositionTypeString,
          matchedAmount: amount.toString(),
          unmatchedAmount: "0",
          unmatchedExpiry: "0",
          claimed: false,
          // Copy odds from maker position (these are the same for both sides of the match)
          upperOdds: upperOdds.toString(),
          lowerOdds: lowerOdds.toString(),
          counterparties: [maker.toLowerCase()],
          counterpartyAmounts: [makerAmountConsumed.toString()], // What the maker put up (consumed)
          createdAt: Timestamp.now(),
        });
        
        console.log(`🔍 TAKER POSITION CREATE (new) - ${takerDocId}:`, {
          takerMatchedAmount: amount.toString(),
          makerAmountConsumed,
          positionType: takerPositionType,
          positionTypeString: takerPositionTypeString,
          // Added odds from maker position
          upperOdds: upperOdds.toString(),
          lowerOdds: lowerOdds.toString(),
          counterparties: [maker.toLowerCase()],
          counterpartyAmounts: [makerAmountConsumed.toString()]
        });
      }
    }
  },
  {
    eventName: "POSITION_ADJUSTED",
    eventHash: "0x9e26edc8d44650e20c5900c65e3c552e0e50ab077836dd27d40286c92142b72b",
    dataSchema: ["uint256", "address", "uint128", "uint32", "uint8", "int256"],
    handler: async (decodedData, eventData) => {
      const [speculationId, user, oddsPairId, newUnmatchedExpiry, positionType, amount] = decodedData;
      console.log("POSITION_ADJUSTED:", { 
        speculationId: speculationId.toString(), 
        user: user.toLowerCase(),
        oddsPairId: oddsPairId.toString(),
        newUnmatchedExpiry: newUnmatchedExpiry.toString(),
        positionType: positionType.toString(),
        amount: amount.toString()
      });

      const amoyPositionsRef = db.collection("amoyPositionsv2.3");
      
      // Create unique document ID: speculationId_user_oddsPairId_positionType
      const docId = `${speculationId.toString()}_${user.toLowerCase()}_${oddsPairId.toString()}_${positionType.toString()}`;
      const positionDoc = amoyPositionsRef.doc(docId);
      
      // Check if position exists
      const docSnapshot = await positionDoc.get();
      
      if (docSnapshot.exists) {
        const currentData = docSnapshot.data();
        if (!currentData) {
          console.error(`ERROR: Position data is null for ${docId}.`);
          return;
        }
        
        // Calculate new unmatched amount based on adjustment
        const currentUnmatched = parseInt(currentData.unmatchedAmount || "0");
        const adjustmentAmount = parseInt(amount.toString());
        const newUnmatchedAmount = (currentUnmatched + adjustmentAmount).toString();
        
        // Prepare update object
        const updateData: any = {
          unmatchedAmount: newUnmatchedAmount,
          updatedAt: Timestamp.now(),
        };
        
        // Update expiry if provided (non-zero value)
        if (newUnmatchedExpiry.toString() !== "0") {
          updateData.unmatchedExpiry = newUnmatchedExpiry.toString();
        }
        
        await positionDoc.update(updateData);
        
        console.log(`Updated position ${docId} - adjustment: ${adjustmentAmount}, new unmatched: ${newUnmatchedAmount}${newUnmatchedExpiry.toString() !== "0" ? `, new expiry: ${newUnmatchedExpiry.toString()}` : ""}`);
      } else {
        console.log(`Position ${docId} not found for adjustment, skipping.`);
      }
    }
  },
  {
    eventName: "POSITION_CLAIMED",
    eventHash: "0x2e7ffcffc5b9e7430e9ceb78e1e29f5261f21e812531be1ae93b7368fda42b60",
    dataSchema: ["uint256", "address", "uint128", "uint8", "uint256"],
    handler: async (decodedData, eventData) => {
      const [speculationId, user, oddsPairId, positionType, payout] = decodedData;
      console.log("POSITION_CLAIMED:", { 
        speculationId: speculationId.toString(), 
        user: user.toLowerCase(), 
        oddsPairId: oddsPairId.toString(),
        positionType: positionType.toString(),
        payout: payout.toString()
      });

      // Update the position document in amoyPositionsv2.3
      const positionsRef = db.collection("amoyPositionsv2.3");
      
      // Query to find the position document
      // Position document ID format: speculationId_user_oddsPairId_positionType
      const positionDocId = `${speculationId.toString()}_${user.toLowerCase()}_${oddsPairId.toString()}_${positionType.toString()}`;
      
      try {
        const positionDoc = positionsRef.doc(positionDocId);
        const positionSnapshot = await positionDoc.get();
        
        if (positionSnapshot.exists) {
          // Update the position with claimed status and payout amount
          await positionDoc.update({
            claimed: true,
            claimedAmount: payout.toString(),
            claimedAt: Timestamp.now(),
            updatedAt: Timestamp.now()
          });
          console.log(`Updated position ${positionDocId} with claimed: true, claimedAmount: ${payout.toString()}`);
        } else {
          console.error(`Position document ${positionDocId} not found in amoyPositionsv2.3`);
        }
      } catch (error) {
        console.error(`Error updating position ${positionDocId}:`, error);
      }
    }
  },
  {
    eventName: "LEADERBOARD_CREATED",
    eventHash: "0xb7e5d550753710baffdd105b5ce4cf1a70bb2899410f4c36fe03b15f22f5637e",
    dataSchema: ["uint256", "uint256", "address", "uint32", "uint32", "uint32", "uint32", "uint32"],
    handler: async (decodedData, eventData) => {
      const [leaderboardId, entryFee, yieldStrategy, startTime, endTime, safetyPeriodDuration, roiSubmissionWindow, claimWindow] = decodedData;
      console.log("LEADERBOARD_CREATED:", { 
        leaderboardId: leaderboardId.toString(), 
        entryFee: entryFee.toString(), 
        yieldStrategy: yieldStrategy.toLowerCase(),
        startTime: startTime.toString(),
        endTime: endTime.toString(),
        safetyPeriodDuration: safetyPeriodDuration.toString(),
        roiSubmissionWindow: roiSubmissionWindow.toString(),
        claimWindow: claimWindow.toString()
      });

      // Store leaderboard in amoyLeaderboardsv2.3 collection
      const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
      const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardId.toString());
      
      // Check if leaderboard already exists
      const docSnapshot = await leaderboardDoc.get();
      
      if (docSnapshot.exists) {
        console.log(`Leaderboard ${leaderboardId.toString()} already exists in amoyLeaderboardsv2.3, skipping.`);
      } else {
        // Create new leaderboard document
        await leaderboardDoc.set({
          leaderboardId: leaderboardId.toString(),
          entryFee: entryFee.toString(),
          yieldStrategy: yieldStrategy.toLowerCase(),
          startTime: startTime.toString(),
          endTime: endTime.toString(),
          safetyPeriodDuration: safetyPeriodDuration.toString(),
          roiSubmissionWindow: roiSubmissionWindow.toString(),
          claimWindow: claimWindow.toString(),
          prizePool: "0", // Initialize as 0
          currentParticipants: 0,
          createdAt: Timestamp.now(),
        });
        console.log(`Created leaderboard ${leaderboardId.toString()} in amoyLeaderboardsv2.3.`);
      }
    }
  },
  {
    eventName: "LEADERBOARD_SPECULATION_ADDED",
    eventHash: "0x1ff96f6d82caf6fb3f681e23e83e68c8d78444f4f42a499db5a604583c955976",
    dataSchema: ["uint256", "uint256"],
    handler: async (decodedData, eventData) => {
      const [leaderboardId, speculationId] = decodedData;
      console.log("LEADERBOARD_SPECULATION_ADDED:", { 
        leaderboardId: leaderboardId.toString(), 
        speculationId: speculationId.toString()
      });

      // Add speculationId to the leaderboard document's speculationIds array
      const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
      const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardId.toString());
      
      try {
        // Use arrayUnion to add the speculationId if it doesn't already exist
        await leaderboardDoc.update({
          speculationIds: FieldValue.arrayUnion(speculationId.toString()),
          lastSpeculationAdded: Timestamp.now()
        });
        console.log(`Added speculation ${speculationId.toString()} to leaderboard ${leaderboardId.toString()} speculationIds array.`);
      } catch (error) {
        // If the document doesn't exist or doesn't have speculationIds field, create it
        if (error instanceof Error && error.message.includes('not-found')) {
          console.log(`Leaderboard ${leaderboardId.toString()} not found. This shouldn't happen if leaderboard was created first.`);
        } else {
          // Document exists but speculationIds field doesn't exist, so set it
          await leaderboardDoc.set({
            speculationIds: [speculationId.toString()],
            lastSpeculationAdded: Timestamp.now()
          }, { merge: true });
          console.log(`Initialized speculationIds array on leaderboard ${leaderboardId.toString()} with speculation ${speculationId.toString()}.`);
        }
      }
    }
  },
  {
    eventName: "USER_REGISTERED",
    eventHash: "0xccb17a25972f03a7de7dc9037b0f601e596376b5abccb1e5fc5b2d246179ad34",
    dataSchema: ["uint256", "address", "uint256"], // leaderboardId, userAddress, declaredBankroll
    handler: async (decodedData, eventData) => {
      const [leaderboardId, userAddress, declaredBankroll] = decodedData;
      console.log("USER_REGISTERED:", { 
        leaderboardId: leaderboardId.toString(), 
        userAddress: userAddress.toLowerCase(),
        declaredBankroll: declaredBankroll.toString()
      });

      // Store individual registration in amoyLeaderboardRegistrationsv2.3 collection
      const amoyRegistrationsRef = db.collection("amoyLeaderboardRegistrationsv2.3");
      
      // Create unique document ID: leaderboardId_userAddress
      const docId = `${leaderboardId.toString()}_${userAddress.toLowerCase()}`;
      const registrationDoc = amoyRegistrationsRef.doc(docId);
      
      // Check if registration already exists
      const docSnapshot = await registrationDoc.get();
      
      if (docSnapshot.exists) {
        console.log(`Registration ${docId} already exists in amoyLeaderboardRegistrationsv2.3, updating with new data.`);
        // Update existing registration (in case of re-registration)
        await registrationDoc.update({
          declaredBankroll: declaredBankroll.toString(),
          updatedAt: Timestamp.now(),
        });
        console.log(`Updated registration ${docId} in amoyLeaderboardRegistrationsv2.3.`);
      } else {
        // Create new registration document
        await registrationDoc.set({
          leaderboardId: leaderboardId.toString(),
          userAddress: userAddress.toLowerCase(),
          declaredBankroll: declaredBankroll.toString(),
          registeredAt: Timestamp.now(),
        });
        console.log(`Created registration ${docId} in amoyLeaderboardRegistrationsv2.3.`);

        // Update leaderboard: increment participant count and add entry fee to prize pool
        const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
        const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardId.toString());
        
        try {
          await db.runTransaction(async (transaction) => {
            const leaderboardSnapshot = await transaction.get(leaderboardDoc);
            
            if (!leaderboardSnapshot.exists) {
              // Create new leaderboard document
              transaction.set(leaderboardDoc, {
                currentParticipants: 1,
                prizePool: "0", // Will be set correctly by future events
                updatedAt: Timestamp.now(),
              }, { merge: true });
              console.log(`Initialized leaderboard ${leaderboardId.toString()} with participant count 1.`);
              return;
            }
            
            const leaderboardData = leaderboardSnapshot.data();
            const currentPrizePool = BigInt(leaderboardData?.prizePool || '0');
            const entryFee = BigInt(leaderboardData?.entryFee || '0');
            const currentParticipants = leaderboardData?.currentParticipants || 0;
            
            const updateData: any = {
              currentParticipants: currentParticipants + 1,
              updatedAt: Timestamp.now(),
            };
            
            // Add entry fee to prize pool if there is one
            if (entryFee > 0) {
              const newPrizePool = currentPrizePool + entryFee;
              updateData.prizePool = newPrizePool.toString();
              
              console.log(`💰 PRIZE POOL UPDATED: Leaderboard ${leaderboardId.toString()} - Entry fee ${entryFee.toString()} added. Prize pool: ${currentPrizePool.toString()} → ${newPrizePool.toString()}, Participants: ${currentParticipants} → ${currentParticipants + 1}`);
            } else {
              console.log(`👥 PARTICIPANTS UPDATED: Leaderboard ${leaderboardId.toString()} participants: ${currentParticipants} → ${currentParticipants + 1} (no entry fee)`);
            }
            
            transaction.update(leaderboardDoc, updateData);
          });
        } catch (error) {
          console.error(`❌ Error updating leaderboard ${leaderboardId.toString()}:`, error);
        }
      }
    }
  },
  {
    eventName: "RULE_SET",
    eventHash: "0x92bf180c755d0ab951ed131383d931546e4ac7b5ab22d116eac9e3b6401e8a79",
    dataSchema: ["uint256", "string", "uint256"],
    handler: async (decodedData, eventData) => {
      const [leaderboardId, ruleType, value] = decodedData;
      console.log("RULE_SET:", { 
        leaderboardId: leaderboardId.toString(), 
        ruleType: ruleType,
        value: value.toString()
      });

      // Update leaderboard in amoyLeaderboardsv2.3 collection
      const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
      const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardId.toString());
      const docSnapshot = await leaderboardDoc.get();
      
      if (docSnapshot.exists) {
        // Update existing leaderboard with the rule
        const updateData: any = {
          updatedAt: Timestamp.now()
        };
        
        // Set the rule using the ruleType as the field name
        updateData[ruleType] = value.toString();
        
        await leaderboardDoc.update(updateData);
        console.log(`Updated leaderboard ${leaderboardId.toString()} with rule ${ruleType}: ${value.toString()}`);
      } else {
        console.log(`No leaderboard found in amoyLeaderboardsv2.3 for leaderboardId ${leaderboardId.toString()}, skipping rule update.`);
      }
    }
  },
  {
    eventName: "LEADERBOARD_POSITION_ADDED",
    eventHash: "0x3fd6b864fdc27cbf3befabeabb947dfb73d5a948368f78ca4a0a209e333cd5d5",
    dataSchema: ["uint256", "address", "uint128", "uint256", "uint8", "uint256"], // speculationId, user, oddsPairId, amount, positionType, leaderboardId
    // NOTE: One event is emitted per leaderboard registration, not one event with an array
    // The Solidity function loops through leaderboardIds and emits a separate event for each one
    handler: async (decodedData, eventData) => {
      const [speculationId, user, oddsPairId, amount, positionType, leaderboardId] = decodedData;
      console.log("LEADERBOARD_POSITION_ADDED:", { 
        speculationId: speculationId.toString(), 
        user: user.toLowerCase(),
        oddsPairId: oddsPairId.toString(),
        amount: amount.toString(),
        positionType: positionType.toString(),
        leaderboardId: leaderboardId.toString()
      });

      const positionTypeString = positionType.toString() === "0" ? "Upper" : "Lower";
      const userLower = user.toLowerCase();
      const timestamp = Timestamp.now();
      const leaderboardIdStr = leaderboardId.toString();

      // 1. Create individual leaderboard position documents for efficient querying
      const amoyLeaderboardPositionsRef = db.collection("amoyLeaderboardPositionsv2.3");
      
      // Document ID: leaderboardId_speculationId_user_oddsPairId_positionType
      const docId = `${leaderboardIdStr}_${speculationId.toString()}_${userLower}_${oddsPairId.toString()}_${positionType.toString()}`;
      const leaderboardPositionDoc = amoyLeaderboardPositionsRef.doc(docId);
      
      // Check if already exists (handle duplicates)
      const docSnapshot = await leaderboardPositionDoc.get();
      
      if (docSnapshot.exists) {
        console.log(`Leaderboard position ${docId} already exists, updating amount.`);
        await leaderboardPositionDoc.update({
          amount: amount.toString(),
          updatedAt: timestamp,
        });
      } else {
        // Create new leaderboard position document
        await leaderboardPositionDoc.set({
          leaderboardId: leaderboardIdStr,
          speculationId: speculationId.toString(),
          user: userLower,
          oddsPairId: oddsPairId.toString(),
          positionType: positionType.toString(),
          positionTypeString: positionTypeString,
          amount: amount.toString(),
          registeredAt: timestamp,
        });
        console.log(`Created leaderboard position ${docId} in amoyLeaderboardPositionsv2.3.`);
      }

      // 2. Update the main position document with leaderboard info for easy display
      const amoyPositionsRef = db.collection("amoyPositionsv2.3");
      const positionDocId = `${speculationId.toString()}_${userLower}_${oddsPairId.toString()}_${positionType.toString()}`;
      const positionDoc = amoyPositionsRef.doc(positionDocId);
      const positionSnapshot = await positionDoc.get();
      
      if (positionSnapshot.exists) {
        const positionData = positionSnapshot.data();
        const currentLeaderboardIds = positionData?.leaderboardIds || [];
        const currentLeaderboardAmounts = positionData?.leaderboardAmounts || [];
        
        // Merge new leaderboard registration with existing ones
        const updatedLeaderboardIds = [...currentLeaderboardIds];
        const updatedLeaderboardAmounts = [...currentLeaderboardAmounts];
        
        const existingIndex = updatedLeaderboardIds.indexOf(leaderboardIdStr);
        if (existingIndex >= 0) {
          // Update existing amount
          updatedLeaderboardAmounts[existingIndex] = amount.toString();
        } else {
          // Add new leaderboard registration
          updatedLeaderboardIds.push(leaderboardIdStr);
          updatedLeaderboardAmounts.push(amount.toString());
        }
        
        await positionDoc.update({
          leaderboardIds: updatedLeaderboardIds,
          leaderboardAmounts: updatedLeaderboardAmounts,
          lastLeaderboardRegistration: timestamp,
          updatedAt: timestamp,
        });
        console.log(`Updated position ${positionDocId} with leaderboard registrations:`, {
          leaderboardIds: updatedLeaderboardIds,
          amounts: updatedLeaderboardAmounts
        });
      } else {
        console.log(`Position ${positionDocId} not found in amoyPositionsv2.3, cannot update with leaderboard info.`);
      }

      // 3. Update leaderboard documents with participation stats
      const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
      const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardIdStr);
      
      try {
        // Increment total positions count and update last activity
        await leaderboardDoc.update({
          totalPositions: FieldValue.increment(1),
          lastPositionAdded: timestamp,
          updatedAt: timestamp,
        });
        console.log(`Updated leaderboard ${leaderboardIdStr} position count.`);
      } catch (error) {
        // If leaderboard doesn't exist or field doesn't exist, initialize it
        await leaderboardDoc.set({
          totalPositions: 1,
          lastPositionAdded: timestamp,
          updatedAt: timestamp,
        }, { merge: true });
        console.log(`Initialized position count for leaderboard ${leaderboardIdStr}.`);
      }
    }
  },
  {
    eventName: "LEADERBOARD_POSITION_UPDATED",
    eventHash: "0xa26bc489af22fa38567ea7e5fae4e5b57aceafbe47379efea50ad48dcedbe90b",
    dataSchema: ["uint256", "address", "uint128", "uint256", "uint8", "uint256"], // speculationId, user, oddsPairId, amount, positionType, leaderboardId
    handler: async (decodedData, eventData) => {
      const [speculationId, user, oddsPairId, amount, positionType, leaderboardId] = decodedData;
      console.log("LEADERBOARD_POSITION_UPDATED:", { 
        speculationId: speculationId.toString(), 
        user: user.toLowerCase(),
        oddsPairId: oddsPairId.toString(),
        amount: amount.toString(),
        positionType: positionType.toString(),
        leaderboardId: leaderboardId.toString()
      });

      const positionTypeString = positionType.toString() === "0" ? "Upper" : "Lower";
      const userLower = user.toLowerCase();
      const timestamp = Timestamp.now();
      const leaderboardIdStr = leaderboardId.toString();

      // 1. Update the leaderboard position document with new amount
      const amoyLeaderboardPositionsRef = db.collection("amoyLeaderboardPositionsv2.3");
      
      // Document ID: leaderboardId_speculationId_user_oddsPairId_positionType
      const docId = `${leaderboardIdStr}_${speculationId.toString()}_${userLower}_${oddsPairId.toString()}_${positionType.toString()}`;
      const leaderboardPositionDoc = amoyLeaderboardPositionsRef.doc(docId);
      
      // Check if position exists
      const docSnapshot = await leaderboardPositionDoc.get();
      
      if (docSnapshot.exists) {
        const previousData = docSnapshot.data();
        const previousAmount = previousData?.amount || "0";
        
        console.log(`Updating leaderboard position ${docId} - Previous amount: ${previousAmount}, New amount: ${amount.toString()}`);
        
        await leaderboardPositionDoc.update({
          amount: amount.toString(),
          updatedAt: timestamp,
        });
        
        console.log(`✅ Updated leaderboard position ${docId} amount: ${previousAmount} → ${amount.toString()}`);
      } else {
        // Position doesn't exist - this shouldn't happen for an UPDATE event
        console.error(`❌ Leaderboard position ${docId} not found for UPDATE event. This shouldn't happen.`);
        
        // Create it anyway to handle edge cases
        await leaderboardPositionDoc.set({
          leaderboardId: leaderboardIdStr,
          speculationId: speculationId.toString(),
          user: userLower,
          oddsPairId: oddsPairId.toString(),
          positionType: positionType.toString(),
          positionTypeString: positionTypeString,
          amount: amount.toString(),
          registeredAt: timestamp,
        });
        console.log(`🔧 Created missing leaderboard position ${docId} with amount ${amount.toString()}`);
      }

      // 2. Update the main position document with updated leaderboard amount
      const amoyPositionsRef = db.collection("amoyPositionsv2.3");
      const positionDocId = `${speculationId.toString()}_${userLower}_${oddsPairId.toString()}_${positionType.toString()}`;
      const positionDoc = amoyPositionsRef.doc(positionDocId);
      const positionSnapshot = await positionDoc.get();
      
      if (positionSnapshot.exists) {
        const positionData = positionSnapshot.data();
        const currentLeaderboardIds = positionData?.leaderboardIds || [];
        const currentLeaderboardAmounts = positionData?.leaderboardAmounts || [];
        
        // Find and update the specific leaderboard amount
        const leaderboardIndex = currentLeaderboardIds.indexOf(leaderboardIdStr);
        if (leaderboardIndex >= 0) {
          const updatedLeaderboardAmounts = [...currentLeaderboardAmounts];
          const previousAmount = updatedLeaderboardAmounts[leaderboardIndex];
          updatedLeaderboardAmounts[leaderboardIndex] = amount.toString();
          
          await positionDoc.update({
            leaderboardAmounts: updatedLeaderboardAmounts,
            lastLeaderboardUpdate: timestamp,
            updatedAt: timestamp,
          });
          
          console.log(`✅ Updated position ${positionDocId} leaderboard amount for leaderboard ${leaderboardIdStr}: ${previousAmount} → ${amount.toString()}`);
        } else {
          console.log(`⚠️ Leaderboard ${leaderboardIdStr} not found in position ${positionDocId} leaderboard registrations. This may be normal for increase-only operations.`);
        }
      } else {
        console.log(`⚠️ Position ${positionDocId} not found in amoyPositionsv2.3 for leaderboard update.`);
      }

      // 3. Update leaderboard last activity
      const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
      const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardIdStr);
      
      try {
        await leaderboardDoc.update({
          lastPositionUpdate: timestamp,
          updatedAt: timestamp,
        });
        console.log(`✅ Updated leaderboard ${leaderboardIdStr} last activity timestamp.`);
      } catch (error) {
        console.log(`⚠️ Could not update leaderboard ${leaderboardIdStr} last activity:`, error);
      }
    }
  },

  // ROI SUBMISSION: Update user registration with submitted ROI
  {
    eventName: "LEADERBOARD_ROI_SUBMITTED",
    eventHash: "0x5f08ddffa691e7e0bbfc0d4041c1a115aad79442afe2b8e92141e23d19786c48",
    dataSchema: ["uint256", "address", "int256"], // leaderboardId, user, roi
    handler: async (decodedData, eventData) => {
      const [leaderboardId, user, roi] = decodedData;
      console.log("LEADERBOARD_ROI_SUBMITTED:", { 
        leaderboardId: leaderboardId.toString(), 
        user: user.toLowerCase(),
        roi: roi.toString()
      });

      const leaderboardIdStr = leaderboardId.toString();
      const userLower = user.toLowerCase();
      const timestamp = Timestamp.now();

      // Update user registration with submitted ROI
      const amoyLeaderboardRegistrationsRef = db.collection("amoyLeaderboardRegistrationsv2.3");
      const docId = `${leaderboardIdStr}_${userLower}`;
      const userRegistrationDoc = amoyLeaderboardRegistrationsRef.doc(docId);

      try {
        const docSnapshot = await userRegistrationDoc.get();
        
        if (docSnapshot.exists) {
          await userRegistrationDoc.update({
            submittedROI: roi.toString(),
            roiSubmittedAt: timestamp,
            updatedAt: timestamp,
          });
          
          console.log(`✅ Updated user ${userLower} registration in leaderboard ${leaderboardIdStr} with ROI: ${roi.toString()}`);
        } else {
          console.error(`❌ User registration ${docId} not found for ROI submission`);
        }
      } catch (error) {
        console.error(`❌ Error updating ROI submission for ${docId}:`, error);
      }

      // Also update leaderboard last activity
      const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
      const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardIdStr);
      
      try {
        await leaderboardDoc.update({
          lastROISubmission: timestamp,
          updatedAt: timestamp,
        });
        console.log(`✅ Updated leaderboard ${leaderboardIdStr} last ROI submission timestamp`);
      } catch (error) {
        console.log(`⚠️ Could not update leaderboard ${leaderboardIdStr} last activity:`, error);
      }
    }
  },

  // NEW HIGHEST ROI: Mark user as current winner
  {
    eventName: "LEADERBOARD_NEW_HIGHEST_ROI",
    eventHash: "0x08a3d394345468c1472ca0110a947e0f1c6ad1063a9e29633025bc0522ce5b0a",
    dataSchema: ["uint256", "int256", "address"], // leaderboardId, newHighestROI, winner
    handler: async (decodedData, eventData) => {
      const [leaderboardId, newHighestROI, winner] = decodedData;
      console.log("LEADERBOARD_NEW_HIGHEST_ROI:", { 
        leaderboardId: leaderboardId.toString(), 
        newHighestROI: newHighestROI.toString(),
        winner: winner.toLowerCase()
      });

      const leaderboardIdStr = leaderboardId.toString();
      const winnerLower = winner.toLowerCase();
      const timestamp = Timestamp.now();

      // Update winner's registration
      const amoyLeaderboardRegistrationsRef = db.collection("amoyLeaderboardRegistrationsv2.3");
      const winnerDocId = `${leaderboardIdStr}_${winnerLower}`;
      const winnerRegistrationDoc = amoyLeaderboardRegistrationsRef.doc(winnerDocId);

      try {
        const docSnapshot = await winnerRegistrationDoc.get();
        
        if (docSnapshot.exists) {
          await winnerRegistrationDoc.update({
            isCurrentWinner: true,
            highestROIAt: timestamp,
            updatedAt: timestamp,
          });
          
          console.log(`✅ Updated user ${winnerLower} as current winner in leaderboard ${leaderboardIdStr}`);
        } else {
          console.error(`❌ Winner registration ${winnerDocId} not found for highest ROI update`);
        }
      } catch (error) {
        console.error(`❌ Error updating highest ROI winner for ${winnerDocId}:`, error);
      }

      // Clear previous winners (set isCurrentWinner = false for others)
      try {
        const registrationsSnapshot = await amoyLeaderboardRegistrationsRef
          .where("leaderboardId", "==", leaderboardIdStr)
          .where("isCurrentWinner", "==", true)
          .get();

        const batch = db.batch();
        let hasUpdates = false;
        
        registrationsSnapshot.docs.forEach(doc => {
          if (doc.id !== winnerDocId) {
            batch.update(doc.ref, { 
              isCurrentWinner: false,
              updatedAt: timestamp
            });
            hasUpdates = true;
          }
        });
        
        if (hasUpdates) {
          await batch.commit();
          console.log(`✅ Cleared previous winners for leaderboard ${leaderboardIdStr}`);
        }
      } catch (error) {
        console.log(`⚠️ Could not clear previous winners for leaderboard ${leaderboardIdStr}:`, error);
      }

      // Update leaderboard with new highest ROI and current winner
      const amoyLeaderboardsRef = db.collection("amoyLeaderboardsv2.3");
      const leaderboardDoc = amoyLeaderboardsRef.doc(leaderboardIdStr);
      
      try {
        await leaderboardDoc.update({
          currentHighestROI: newHighestROI.toString(),
          currentWinner: winnerLower,
          lastHighestROIUpdate: timestamp,
          updatedAt: timestamp,
        });
        console.log(`✅ Updated leaderboard ${leaderboardIdStr} with new highest ROI: ${newHighestROI.toString()}, winner: ${winnerLower}`);
      } catch (error) {
        console.log(`⚠️ Could not update leaderboard ${leaderboardIdStr} highest ROI data:`, error);
      }
    }
  }
  // Add new event handlers here as they're implemented
];

// Helper function to get event handler by hash
function getEventHandler(eventHash: string): EventHandler | undefined {
  return EVENT_HANDLERS.find(handler => handler.eventHash === eventHash);
}

// Helper function to get event handler by name
function getEventHandlerByName(eventName: string): EventHandler | undefined {
  return EVENT_HANDLERS.find(handler => handler.eventName === eventName);
}

export const insightWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    // Log the full incoming request and timestamp
    console.log("[Webhook received]", new Date().toISOString(), JSON.stringify(req.body, null, 2));

    // Handle different webhook formats
    if (req.body.data && req.body.data[0] && req.body.data[0].data) {
      // Thirdweb format
      const log = req.body.data[0].data;
      console.log("[Thirdweb format detected]");
      
      // CoreEventEmitted event signature hash
      const COREEVENTEMITTED_TOPIC = "0x05a981d03316d55f7ca9ffff0cd10dda8e9ceeea936b6fc212d46cf3f8a73364";

      // Only process logs that match the CoreEventEmitted event
      if (log.topics[0] !== COREEVENTEMITTED_TOPIC) {
        console.log("Ignoring non-CoreEventEmitted event:", log.topics[0]);
        res.status(200).send("Ignored non-CoreEventEmitted event");
        return;
      }

      const eventTypeKey = log.topics[1];
      const eventData = log.data;

      // Find handler for this event
      const eventHandler = getEventHandler(eventTypeKey);
      const eventType = eventHandler?.eventName || eventTypeKey;

      // Log eventType, eventTypeKey, and eventData with timestamp
      console.log(`[Event received] ${new Date().toISOString()} eventType:`, eventType, "eventTypeKey:", eventTypeKey, "eventData:", eventData);

      // Process event using registered handler
      if (eventHandler) {
        try {
          // Decode the event data
          const [inner] = AbiCoder.defaultAbiCoder().decode(["bytes"], eventData);
          const decodedData = AbiCoder.defaultAbiCoder().decode(eventHandler.dataSchema, inner);

          // Call the event handler
          await eventHandler.handler(decodedData, { eventTypeKey, eventData, log });

          console.log(`[Event processed] Successfully processed ${eventType}`);
        } catch (error) {
          console.error(`[Event error] Failed to process ${eventType}:`, error);
        }
      } else {
        console.log(`[Event ignored] No handler registered for eventType: ${eventType} (${eventTypeKey})`);
      }
      
      res.status(200).send("ok");
      return;
    } else if (req.body.event && req.body.event.data && req.body.event.data.block && req.body.event.data.block.logs) {
      // Alchemy format - check if there are any logs
      const alchemyLogs = req.body.event.data.block.logs;
      if (alchemyLogs.length === 0) {
        console.log("[Alchemy format - no events in this block, skipping]");
        res.status(200).send("No events in block");
        return;
      }
      console.log(`[Alchemy format detected] Processing ${alchemyLogs.length} events`);
      
      // Process ALL logs in the transaction
      for (let i = 0; i < alchemyLogs.length; i++) {
        const log = alchemyLogs[i];
        
        // CoreEventEmitted event signature hash
        const COREEVENTEMITTED_TOPIC = "0x05a981d03316d55f7ca9ffff0cd10dda8e9ceeea936b6fc212d46cf3f8a73364";

        // Only process logs that match the CoreEventEmitted event
        if (log.topics[0] !== COREEVENTEMITTED_TOPIC) {
          console.log(`[Event ${i}] Ignoring non-CoreEventEmitted event:`, log.topics[0]);
          continue;
        }

        const eventTypeKey = log.topics[1];
        const eventData = log.data;

        // Find handler for this event
        const eventHandler = getEventHandler(eventTypeKey);
        const eventType = eventHandler?.eventName || eventTypeKey;

        // Log eventType, eventTypeKey, and eventData with timestamp
        console.log(`[Event ${i} received] ${new Date().toISOString()} eventType:`, eventType, "eventTypeKey:", eventTypeKey, "eventData:", eventData);

        // Process event using registered handler
        if (eventHandler) {
          try {
            // Decode the event data
            const [inner] = AbiCoder.defaultAbiCoder().decode(["bytes"], eventData);
            const decodedData = AbiCoder.defaultAbiCoder().decode(eventHandler.dataSchema, inner);

            // Call the event handler
            await eventHandler.handler(decodedData, { eventTypeKey, eventData, log });

            console.log(`[Event ${i} processed] Successfully processed ${eventType}`);
          } catch (error) {
            console.error(`[Event ${i} error] Failed to process ${eventType}:`, error);
          }
        } else {
          console.log(`[Event ${i} ignored] No handler registered for eventType: ${eventType} (${eventTypeKey})`);
        }
      }
      
      res.status(200).send("ok");
      return;
    } else {
      console.log("[Unknown webhook format, ignoring]");
      res.status(200).send("Unknown format");
      return;
    }
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Internal Server Error");
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
        { ...doc.data(), archivedDate: now });
      contestsArchiveBatch.delete(doc.ref);
    });

    // Archive speculations
    const speculationsQuerySnapshot = await db.collection("speculations")
      .where("lockTime", "<=", now).get();
    const speculationsArchiveBatch = db.batch();
    speculationsQuerySnapshot.forEach((doc) => {
      const archiveRef = db.collection("speculations_archive").doc(doc.id);
      speculationsArchiveBatch.set(archiveRef,
        { ...doc.data(), archivedDate: now });
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

// Generic function to sync missed events for any event type
export const syncMissedEvents = functions.https.onCall(async (data, context) => {
  try {
    console.log("[Manual Sync] Starting sync for missed events...");

    const eventTypesToSync = data.eventTypes || EVENT_HANDLERS.map(h => h.eventName);
    console.log(`[Manual Sync] Syncing event types: ${eventTypesToSync.join(', ')}`);

    let totalSynced = 0;
    const results: any = {};

    // Sync each event type
    for (const eventTypeName of eventTypesToSync) {
      const eventHandler = getEventHandlerByName(eventTypeName);
      if (!eventHandler) {
        console.log(`[Manual Sync] No handler found for event type: ${eventTypeName}`);
        continue;
      }

      console.log(`[Manual Sync] Syncing ${eventTypeName} events...`);

      try {
        const syncedCount = await syncEventType(eventHandler);
        results[eventTypeName] = syncedCount;
        totalSynced += syncedCount;
        console.log(`[Manual Sync] Synced ${syncedCount} ${eventTypeName} events`);
      } catch (error) {
        console.error(`[Manual Sync] Error syncing ${eventTypeName}:`, error);
        results[eventTypeName] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    console.log(`[Manual Sync] Completed. Total synced: ${totalSynced}`);
    return { totalSynced, results };
  } catch (error) {
    console.error("[Manual Sync] Error:", error);
    throw new functions.https.HttpsError('internal', 'Sync failed');
  }
});

// Helper function to sync a specific event type
async function syncEventType(eventHandler: EventHandler): Promise<number> {
  const polygonScanKey = functions.config().polygonscan?.api_key || 'YourKey';

  // Get recent events from blockchain (last 1000 blocks for efficiency)
  const response = await fetch(
    `https://amoy.polygonscan.com/api?module=logs&action=getLogs&address=0x8A583cc9282CC6dC735389d2Ca7Ea7Df3A2D3f7b&topic0=0x05a981d03316d55f7ca9ffff0cd10dda8e9ceeea936b6fc212d46cf3f8a73364&topic1=${eventHandler.eventHash}&fromBlock=-1000&toBlock=latest&apikey=${polygonScanKey}`);

  if (!response.ok) {
    throw new Error(`PolygonScan API failed: ${response.statusText}`);
  }

  const result = await response.json();

  if (result.status !== "1" || !result.result || result.result.length === 0) {
    console.log(`[Sync ${eventHandler.eventName}] No recent events found`);
    return 0;
  }

  let syncedCount = 0;

  for (const log of result.result) {
    try {
      // Decode the event data
      const [inner] = AbiCoder.defaultAbiCoder().decode(["bytes"], log.data);
      const decodedData = AbiCoder.defaultAbiCoder().decode(eventHandler.dataSchema, inner);

      // Check if this event was already processed by checking a timestamp or unique identifier
      // For now, we'll re-run the handler and let it handle duplicates
      await eventHandler.handler(decodedData, {
        eventTypeKey: eventHandler.eventHash,
        eventData: log.data,
        log,
        isSync: true // Flag to indicate this is a sync operation
      });

      syncedCount++;
    } catch (error) {
      console.log(`[Sync ${eventHandler.eventName}] Could not process log:`, error);
    }
  }

  return syncedCount;
}

// Scheduled poller to prevent future misses (runs every 10 minutes)
// COMMENTED OUT: Risk of duplicating events when webhooks are working
// TODO: Consider implementing targeted event recovery for specific blocks/transactions instead
/*
export const pollForMissedEvents = functions.pubsub
  .schedule('every 10 minutes')
  .onRun(async (context) => {
    try {
      console.log("[Scheduled Poll] Checking for missed events...");

      // Poll for all registered event types
      let totalPolled = 0;

      for (const eventHandler of EVENT_HANDLERS) {
        try {
          console.log(`[Scheduled Poll] Checking ${eventHandler.eventName} events...`);
          const polledCount = await syncEventType(eventHandler);
          totalPolled += polledCount;

          if (polledCount > 0) {
            console.log(`[Scheduled Poll] Found and processed ${polledCount} ${eventHandler.eventName} events`);
          }
        } catch (error) {
          console.error(`[Scheduled Poll] Error checking ${eventHandler.eventName}:`, error);
        }
      }

      if (totalPolled > 0) {
        console.log(`[Scheduled Poll] Total events processed: ${totalPolled}`);
      } else {
        console.log("[Scheduled Poll] No missed events found");
      }
    } catch (error) {
      console.error("[Scheduled Poll] Error:", error);
    }
  });
*/

