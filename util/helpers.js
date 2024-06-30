// Function to update the original array with the modified subset | needs to have ids
export const updateOriginalArray = (originalArray, modifiedSubset) => {
    const updatedArray = originalArray.map(originalObject => {
      const modifiedObject = modifiedSubset.find(subsetObject => subsetObject.id === originalObject.id);
      return modifiedObject ? { ...originalObject, ...modifiedObject } : originalObject;
    });
    return updatedArray;
  };
  
export const calculateTimeRemaining = (timer) => {
  const now = new Date().getTime();
  const targetTime = new Date(timer).getTime();
  const timeDifference = targetTime - now;
  return Math.max(0, timeDifference);
}

export const removeModelProperties = (obj, properties) => {
  const result = obj.toObject(); // Convert Mongoose document to plain JavaScript object
  properties.forEach(prop => delete result[prop]);
  return result;
}