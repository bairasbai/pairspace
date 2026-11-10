import { registerRootComponent } from 'expo';
import App from '../App';
import '../index';


jest.mock('expo', () => ({ registerRootComponent: jest.fn() }));
jest.mock('../App', () => ({ __esModule: true, default: function App() { return null; } }));

it('registers the mobile root', () => {
  expect(registerRootComponent).toHaveBeenCalledWith(App);
});
