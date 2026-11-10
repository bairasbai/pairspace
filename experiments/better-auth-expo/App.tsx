import { Text, View } from 'react-native';
import { authClient } from './src/auth-client';
export default function App() {
  return <View><Text>Isolated auth import spike: {typeof authClient.signIn.email}</Text></View>;
}
