import HttpError from '../models/Http-error.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { findUserByName } from '../services/main-services/user-service.js';

export const postCard = async (req, res, next) => {
  const { text, gif, sender, receiver, randomReceiver, hideSender } = req.body;

  if (randomReceiver) {
    let targetUser;
    try {
      let random = await User.aggregate([{ $sample: { size: 1 } }]);
      targetUser = random[0];
    } catch (err) {
      return next(new HttpError('Could not find a user with that name <;(', 404));
    }
    if (!targetUser) {
      return next(new HttpError('Could not find a user with that name <;(', 404));
    }
    try {
      const sess = await mongoose.startSession();
      sess.startTransaction();
      targetUser.christmas.push({
        sender: hideSender ? 'Hidden Santa Claus' : sender,
        receiver: receiver,
        text,
        gif,
      });
      await targetUser.save();
      await sess.commitTransaction();
    } catch (err) {
      console.log(err);
      return next(
        new HttpError('Could not send the card to the user - please try again!', 500)
      );
    }
  } else {
    const [firstName, lastName] = receiver.split(' ');

    let targetUser;
    try {
      targetUser = await findUserByName(firstName, lastName);
    } catch (err) {
      return next(new HttpError('Could not find a user with that name <;(', 404));
    }

    if (!targetUser) {
      return next(new HttpError('Could not find a user with that name <;(', 404));
    }
    try {
      const sess = await mongoose.startSession();
      sess.startTransaction();
      targetUser.christmas.push({
        sender: hideSender ? 'Hidden Santa Claus' : sender,
        receiver: receiver,
        text,
        gif,
      });
      await targetUser.save();
      await sess.commitTransaction();
    } catch (err) {
      return next(
        new HttpError('Could not send the card to the user - please try again!', 500)
      );
    }
  }

  res.status(201).json({ message: 'Success' });
};
