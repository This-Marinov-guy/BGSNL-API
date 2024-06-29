// Function to update the original array with the modified subset | needs to have ids
export const updateOriginalArray = (originalArray, modifiedSubset) => {
    const updatedArray = originalArray.map(originalObject => {
      const modifiedObject = modifiedSubset.find(subsetObject => subsetObject.id === originalObject.id);
      return modifiedObject ? { ...originalObject, ...modifiedObject } : originalObject;
    });
    return updatedArray;
  };
  